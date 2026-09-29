// QuadPlanet's pure tier: the cube-sphere quadtree, chunk meshes, streaming, terrain sampling and
// the walker/ship/autopilot simulation, without a window. The live tier (the real app, keys and
// screenshots) is tests/quadplanet_live.rs driving tests/features/quadplanet_live.feature.
import { describe, expect, it } from "vitest";
import { type Vec3, cross, distance, dot, length, normalize, sub } from "../src/apps/quadplanet/qp_math";
import {
    PLANETS, FINEST_SPACING, altitudeAboveGround, findLandingSite, maxRelief, sampleSurface, surfaceNormal, surfacePoint, SUN_DIRECTION,
} from "../src/apps/quadplanet/qp_planet";
import {
    type ChunkNode, CHUNK_SEGMENTS, VERTEX_FLOATS, MATERIAL_LAND, PlanetStreamer, buildChunk, chunkKey, cubeToSphere, faceDirection,
    maxLevelFor, nodeParamSize, nodesOverlap, packChunkUv, selectChunks,
} from "../src/apps/quadplanet/qp_quadtree";
import {
    NO_INPUT, BOARD_DISTANCE, cameraPose, initialState, interact, planAutopilot, readout, startAutopilot, step, upAt, autopilotEase,
} from "../src/apps/quadplanet/qp_sim";
import { packWorld, WORLD_FLOATS } from "../src/apps/quadplanet/qp_shader";
import { buildShip, buildSky, buildWalkerBody } from "../src/apps/quadplanet/qp_models";
import { bezier } from "../src/apps/quadplanet/qp_math";

const verdant = PLANETS[0];
const DT = 1 / 30;
const walkOn = (id: number) => ({ ...NO_INPUT, forward: id === 0 });

const vert = (data: number[], i: number): Vec3 => [data[i * VERTEX_FLOATS], data[i * VERTEX_FLOATS + 1], data[i * VERTEX_FLOATS + 2]];

describe("the cube-sphere", () => {
    it("maps every face onto the unit sphere", () => {
        for (let face = 0; face < 6; face++) {
            for (const [a, b] of [[-1, -1], [0, 0], [1, 0.3], [-0.7, 1]]) {
                expect(length(faceDirection(face, a, b))).toBeCloseTo(1, 9);
            }
        }
        expect(cubeToSphere([1, 1, 1])).toEqual(normalize([1, 1, 1]));
    });

    it("joins neighbouring faces without a seam", () => {
        // Face 0 (+X) at a = 1 is the same cube edge as face 5 (-Z) at a = -1.
        for (const b of [-1, -0.5, 0, 0.8, 1]) {
            const p = faceDirection(0, 1, b), q = faceDirection(5, -1, b);
            expect(distance(p, q)).toBeLessThan(1e-12);
        }
    });

    it("picks a deepest level that makes leaf cells about a meter", () => {
        for (const p of PLANETS) {
            const L = maxLevelFor(p);
            const cell = (nodeParamSize(L) * p.radius * Math.PI / 4) / CHUNK_SEGMENTS;
            expect(cell).toBeLessThan(1.3);
            expect(cell).toBeGreaterThan(0.5);
        }
    });
});

describe("chunk meshes", () => {
    const node: ChunkNode = { planet: 0, face: 4, level: 5, ia: 13, ib: 17 };

    it("wind every surface triangle counter-clockwise from outside (the engine culls back faces)", () => {
        const mesh = buildChunk(verdant, node);
        const grid = CHUNK_SEGMENTS * CHUNK_SEGMENTS * 2;
        for (let t = 0; t < grid; t++) {
            const [a, b, c] = [0, 1, 2].map(k => vert(mesh.vertexData, mesh.indexData[t * 3 + k]));
            const n = cross(sub(b, a), sub(c, a));
            const out = normalize(sub(a, verdant.center));
            expect(dot(n, out)).toBeGreaterThan(0);
        }
    });

    it("share their border vertices exactly with a same-level neighbour", () => {
        const left = buildChunk(verdant, node);
        const right = buildChunk(verdant, { ...node, ia: node.ia + 1 });
        const V = CHUNK_SEGMENTS + 1;
        for (let j = 0; j < V; j++) {
            const p = vert(left.vertexData, j * V + CHUNK_SEGMENTS);
            const q = vert(right.vertexData, j * V);
            expect(distance(p, q)).toBeLessThan(1e-9);
        }
    });

    it("hang a skirt under every edge, below the surface", () => {
        const mesh = buildChunk(verdant, node);
        const V = CHUNK_SEGMENTS + 1;
        expect(mesh.vertexCount).toBe(V * V + 4 * V);
        for (let i = V * V; i < mesh.vertexCount; i++) {
            expect(altitudeAboveGround(verdant, vert(mesh.vertexData, i))).toBeLessThan(-1);
        }
    });

    it("pack material, level and the chunk-local grid position into uv", () => {
        const mesh = buildChunk(verdant, node);
        const u = mesh.vertexData[6], v = mesh.vertexData[7];
        expect(Math.floor(u + 0.0005)).toBeLessThanOrEqual(2);
        expect(Math.floor(v + 0.0005)).toBe(node.level);
        expect(packChunkUv(MATERIAL_LAND, 1)).toBeLessThan(1);
        expect(Math.floor(packChunkUv(3, 1) + 0.0005)).toBe(3);
    });
});

describe("the quadtree around a viewer", () => {
    const site = findLandingSite(verdant, SUN_DIRECTION);
    const standing = surfacePoint(verdant, site);
    const eye: Vec3 = [standing[0] + site[0] * 1.7, standing[1] + site[1] * 1.7, standing[2] + site[2] * 1.7];

    it("is finest under your feet and coarse far away", () => {
        const { leaves } = selectChunks(verdant, 0, eye);
        const deepest = Math.max(...leaves.map(l => l.level));
        expect(deepest).toBe(maxLevelFor(verdant));
        const near = leaves.reduce((best, l) => {
            const d = distance(eye, surfacePoint(verdant, faceDirection(l.face, -1 + (l.ia + 0.5) * nodeParamSize(l.level), -1 + (l.ib + 0.5) * nodeParamSize(l.level))));
            return d < best.d ? { d, l } : best;
        }, { d: Infinity, l: leaves[0] });
        expect(near.l.level).toBe(deepest);
        expect(leaves.length).toBeLessThan(400);
    });

    it("never overlaps itself", () => {
        const { leaves } = selectChunks(verdant, 0, eye);
        for (let i = 0; i < leaves.length; i++) {
            for (let j = i + 1; j < leaves.length; j++) expect(nodesOverlap(leaves[i], leaves[j])).toBe(false);
        }
    });

    it("from deep space is a handful of coarse chunks per planet", () => {
        const far: Vec3 = [2600, 450, -1700];
        PLANETS.forEach((p, i) => {
            const { leaves } = selectChunks(p, i, far);
            expect(leaves.length).toBeLessThanOrEqual(24);
            expect(Math.max(...leaves.map(l => l.level))).toBe(1);
        });
    });
});

describe("streaming", () => {
    // Every wanted chunk's ground must be drawn by live chunks at every moment: by itself, by a
    // live ancestor, or by live descendants that tile it completely.
    function covered(want: ChunkNode, live: ChunkNode[]): boolean {
        const same = live.filter(l => nodesOverlap(l, want));
        if (same.some(l => l.level <= want.level)) return true;
        const area = same.reduce((s, l) => s + 4 ** (want.level - l.level), 0);
        return Math.abs(area - 1) < 1e-9;
    }

    it("builds the closest chunks first and drops nothing before its replacement is live", () => {
        const created: string[] = [];
        const streamer = new PlanetStreamer([verdant], { create: id => { created.push(id); }, destroy: () => {} });
        const a = surfacePoint(verdant, findLandingSite(verdant, SUN_DIRECTION));
        let stats = streamer.update(a, 1000, 1e9);
        expect(stats.pending).toBe(0);
        // The first chunk built is the one under the viewer (a deepest-level chunk).
        expect(created[0]).toMatch(new RegExp(`^qp-0-\\d-${maxLevelFor(verdant)}-`));

        // Fly up and away; stream a few chunks per frame. Ground that was drawn stays drawn every
        // frame (ground that was below the old horizon simply hasn't been streamed yet).
        const b: Vec3 = [a[0] * 1.6, a[1] * 1.6, a[2] * 1.6];
        const wanted = selectChunks(verdant, 0, b).leaves;
        let before = [...streamer.live.values()].map(c => c.node);
        let checked = 0;
        for (let frame = 0; frame < 200; frame++) {
            stats = streamer.update(b, 3, 1e9);
            const after = [...streamer.live.values()].map(c => c.node);
            for (const w of wanted) {
                if (!covered(w, before)) continue;
                expect(covered(w, after)).toBe(true);
                checked++;
            }
            before = after;
            if (stats.pending === 0) break;
        }
        expect(checked).toBeGreaterThan(100);
        for (const w of wanted) expect(covered(w, before)).toBe(true);
        expect(stats.pending).toBe(0);
        expect(stats.destroyed).toBeGreaterThan(0);
        expect(streamer.live.size).toBe(stats.wanted);
    });

    it("clears every chunk it made", () => {
        const live = new Set<string>();
        const streamer = new PlanetStreamer(PLANETS, { create: id => { live.add(id); }, destroy: id => { live.delete(id); } });
        streamer.update([0, 0, 3000], 1000, 1e9);
        expect(live.size).toBeGreaterThan(0);
        streamer.clear();
        expect(live.size).toBe(0);
        expect(chunkKey({ planet: 1, face: 2, level: 3, ia: 4, ib: 5 })).toBe("qp-1-2-3-4-5");
    });
});

describe("terrain", () => {
    it("is deterministic and within each planet's relief", () => {
        for (const p of PLANETS) {
            for (let k = 0; k < 200; k++) {
                const d = normalize([Math.sin(k * 1.7), Math.cos(k * 2.3), Math.sin(k * 0.37 + 1)]);
                const s = sampleSurface(p, d);
                expect(sampleSurface(p, d)).toEqual(s);
                expect(Math.abs(s.terrain)).toBeLessThanOrEqual(maxRelief(p));
                if (!p.hasSea) expect(s.sea).toBe(false);
            }
        }
    });

    it("drops detail a coarse mesh can't show, and keeps all of it at the finest spacing", () => {
        const d = normalize([0.3, 0.8, -0.5]);
        expect(sampleSurface(verdant, d, 0.2)).toEqual(sampleSurface(verdant, d, FINEST_SPACING));
        // Neighbouring samples one coarse step apart differ less once band-limited.
        const rough = (spacing: number) => {
            let sum = 0;
            for (let k = 0; k < 300; k++) {
                const a = normalize([Math.sin(k), Math.cos(k * 1.3), Math.sin(k * 0.7 + 2)]);
                const b = normalize([a[0] + 3 / verdant.radius, a[1], a[2]]);
                sum += Math.abs(sampleSurface(verdant, a, spacing).terrain - sampleSurface(verdant, b, spacing).terrain);
            }
            return sum;
        };
        expect(rough(80)).toBeLessThan(rough(FINEST_SPACING) * 0.7);
    });

    it("finds flat dry landing sites on every planet", () => {
        for (const p of PLANETS) {
            const d = findLandingSite(p, SUN_DIRECTION);
            const s = sampleSurface(p, d);
            if (!p.frozenSea) expect(s.sea).toBe(false);
            expect(dot(surfaceNormal(p, d, 1.5), d)).toBeGreaterThan(0.9);
        }
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
        const south: Vec3 = findLandingSite(verdant, [0, -1, 0.2]);
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

    it("autopilots to every other planet on a path clear of all of them, and you step out there", () => {
        for (const target of [1, 2]) {
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
            // Landing sites are in daylight.
            expect(dot(upAt(PLANETS[target], s.ship.pos), SUN_DIRECTION)).toBeGreaterThan(0);
            expect(interact(s)).toBe("exited");
            expect(s.visited).toContain(PLANETS[target].id);
            expect(readout(s).planet).toBe(PLANETS[target].name);
        }
    });

    it("eases in and out", () => {
        expect(autopilotEase(0)).toBe(0);
        expect(autopilotEase(1)).toBe(1);
        expect(autopilotEase(0.5)).toBeCloseTo(0.5, 9);
        expect(autopilotEase(0.05)).toBeLessThan(0.01);
    });
});

describe("rendering data", () => {
    it("packs the world uniform in the shader's layout", () => {
        const w = packWorld({ sunDir: [0, 1, 0], time: 2, sunColor: [1, 1, 1], exposure: 1, debugLod: true, planets: PLANETS.map(p => ({ center: p.center, radius: p.radius, atmosphere: p.atmosphereColor, atmosphereHeight: p.atmosphereHeight })) });
        expect(w.length).toBe(WORLD_FLOATS);
        expect([...w.slice(8, 12)]).toEqual([1, 1, 3, 0]);
        expect(w[12 + 4 + 3]).toBe(PLANETS[1].radius);
        expect(w[24 + 3]).toBe(PLANETS[0].atmosphereHeight);
    });

    it("builds closed, outward-facing models and an inward-facing sky", () => {
        for (const model of [buildShip(), buildWalkerBody()]) {
            expect(model.vertexData.length % VERTEX_FLOATS).toBe(0);
            expect(Math.max(...model.indexData)).toBeLessThan(model.vertexData.length / VERTEX_FLOATS);
        }
        const sky = buildSky();
        let inward = 0, total = 0;
        for (let t = 0; t < sky.indexData.length; t += 3) {
            const [a, b, c] = [0, 1, 2].map(k => vert(sky.vertexData, sky.indexData[t + k]));
            const n = cross(sub(b, a), sub(c, a));
            if (length(n) < 1e-9) continue;
            total++;
            if (dot(n, a) < 0) inward++;
        }
        expect(inward).toBe(total);
    });
});
