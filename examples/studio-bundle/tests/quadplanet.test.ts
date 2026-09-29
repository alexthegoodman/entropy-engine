// QuadPlanet's pure tier: the cube-sphere quadtree, chunk meshes, streaming, terrain sampling and
// the walker/ship/autopilot simulation, without a window. The live tier (the real app, keys and
// screenshots) is tests/quadplanet_live.rs driving tests/features/quadplanet_live.feature.
import { describe, expect, it, vi } from "vitest";
import * as planetSampling from "../src/apps/quadplanet/qp_planet";
import { type Vec3, add, cross, distance, dot, length, normalize, sub } from "../src/apps/quadplanet/qp_math";
import {
    PLANETS, finestSpacing, altitudeAboveGround, findLandingSite, maxRelief, sampleSurface, surfaceNormal, surfacePoint, SUN_DIRECTION,
    chunkResolutions, chunkVerticesFor, MAX_CHUNK_LEVELS, type PlanetDef,
} from "../src/apps/quadplanet/qp_planet";
import {
    type ChunkNode, type ChunkMesh, CHUNK_SEGMENTS, POSITION_QUANTUM, VERTEX_FLOATS, MATERIAL_LAND, LeafIndex, PlanetStreamer, buildChunk, chunkKey, cubeToSphere, faceDirection,
    maxLevelFor, nodeParamSize, nodesOverlap, packChunkUv, selectChunks, wrapFace,
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

/** Vertex i's world position: chunk meshes store positions relative to their origin. */
const vert = (mesh: { vertexData: number[]; origin?: Vec3 }, i: number): Vec3 => {
    const d = mesh.vertexData, o = mesh.origin ?? [0, 0, 0];
    return add(o, [d[i * VERTEX_FLOATS], d[i * VERTEX_FLOATS + 1], d[i * VERTEX_FLOATS + 2]]);
};
/** Every level with the border grid's own 17 vertices: the uniform mesh path. */
const uniform17: PlanetDef = { ...verdant, chunkDetail: { mode: "explicit", verticesPerLevel: Array(14).fill(CHUNK_SEGMENTS + 1) } };

describe("configurable chunk interiors", () => {
    it("samples and shades only emitted vertices, plus one center sample", () => {
        const sample = vi.spyOn(planetSampling, "sampleSurface");
        const color = vi.spyOn(planetSampling, "surfaceColor");
        try {
            for (const vertices of [3, 8, 32, 64]) {
                sample.mockClear();
                color.mockClear();
                const p: PlanetDef = { ...verdant, chunkDetail: { mode: "explicit", verticesPerLevel: Array(8).fill(vertices) } };
                const mesh = buildChunk(p, { planet: 0, face: 4, level: 5, ia: 13, ib: 17, stitch: 255 });
                // Normal estimation also samples inside qp_planet; these spies count calls made
                // by the mesh builder, catching discarded grids and duplicate border work. The
                // interior grid's outer ring (4 x (vertices - 1) samples) is sampled but not
                // emitted: it gives the interior its normals.
                expect(sample).toHaveBeenCalledTimes(mesh.vertexCount + 1 + 4 * (vertices - 1));
                expect(color).toHaveBeenCalledTimes(mesh.vertexCount);
            }
        } finally {
            sample.mockRestore();
            color.mockRestore();
        }
    });

    it("halves vertex counts from leaf to root, with a minimum of three", () => {
        const detail = { mode: "half", leafVertices: 64, levels: 8 } as const;
        expect(chunkResolutions(detail)).toEqual([64, 32, 16, 8, 4, 3, 3, 3]);
        const p = { ...verdant, chunkDetail: detail };
        expect(maxLevelFor(p)).toBe(7);
        expect(chunkVerticesFor(p, 7)).toBe(64);
        expect(chunkVerticesFor(p, 6)).toBe(32);
        expect(chunkVerticesFor(p, 0)).toBe(3);
    });

    it("takes explicit leaf-to-root counts and derives the level count", () => {
        const p: PlanetDef = { ...verdant, chunkDetail: { mode: "explicit", verticesPerLevel: [48, 24, 12, 8] } };
        expect(maxLevelFor(p)).toBe(3);
        expect([3, 2, 1, 0].map(l => chunkVerticesFor(p, l))).toEqual([48, 24, 12, 8]);
        const leaves = selectChunks(p, 0, surfacePoint(p, SUN_DIRECTION)).leaves;
        expect(Math.max(...leaves.map(n => n.level))).toBe(3);
        p.chunkDetail = { mode: "explicit", verticesPerLevel: [5] };
        expect(selectChunks(p, 0, surfacePoint(p, SUN_DIRECTION)).leaves.every(n => n.level === 0)).toBe(true);
        expect(finestSpacing(p)).toBeGreaterThan(finestSpacing(verdant));
    });

    it("rejects invalid counts and depths before building", () => {
        for (const leafVertices of [0, 2, 3.5, 258, NaN, Infinity]) {
            expect(() => chunkResolutions({ mode: "half", leafVertices, levels: 8 })).toThrow();
        }
        for (const levels of [0, 1.5, MAX_CHUNK_LEVELS + 1, NaN, Infinity]) {
            expect(() => chunkResolutions({ mode: "half", leafVertices: 32, levels })).toThrow();
        }
        for (const verticesPerLevel of [[], [17, 0], [17, 2.5], Array(MAX_CHUNK_LEVELS + 1).fill(17)]) {
            expect(() => chunkResolutions({ mode: "explicit", verticesPerLevel })).toThrow();
        }
    });

    it("changes only interior density, preserving every used border vertex and covering the chunk", () => {
        const node: ChunkNode = { planet: 0, face: 4, level: 5, ia: 13, ib: 17 };
        const boundary = (mesh: ChunkMesh) => {
            const used = new Set(mesh.indexData);
            return [...used].map(i => [...vert(mesh, i), ...mesh.vertexData.slice(i * VERTEX_FLOATS + 3, (i + 1) * VERTEX_FLOATS)]).filter(v => {
                const u = (v[6] - Math.floor(v[6]) - 0.001) / 0.99;
                const w = (v[7] - node.level - 0.001) / 0.99;
                return Math.min(Math.abs(u), Math.abs(1 - u), Math.abs(w), Math.abs(1 - w)) < 1e-9;
            }).map(v => JSON.stringify(v)).sort();
        };
        for (let stitch = 0; stitch < 16; stitch++) {
            const n = { ...node, stitch: stitch | 0xf0 };
            const original = buildChunk(uniform17, n);
            for (const vertices of [3, 4, 8, 16, 32, 64]) {
                const p: PlanetDef = { ...verdant, chunkDetail: { mode: "explicit", verticesPerLevel: Array(8).fill(vertices) } };
                const mesh = buildChunk(p, n);
                expect(boundary(mesh)).toEqual(boundary(original));
                expect(mesh.vertexCount).toBe((vertices - 2) ** 2 + boundary(original).length);
                expect(new Set(mesh.indexData).size).toBe(mesh.vertexCount);
                let area = 0;
                for (let t = 0; t < mesh.indexData.length; t += 3) {
                    const [a, b, c] = mesh.indexData.slice(t, t + 3).map(i => [...vert(mesh, i), ...mesh.vertexData.slice(i * VERTEX_FLOATS + 3, (i + 1) * VERTEX_FLOATS)]);
                    const signedArea = ((b[6] - a[6]) * (c[7] - a[7]) - (b[7] - a[7]) * (c[6] - a[6])) / (2 * 0.99 ** 2);
                    expect(signedArea).toBeGreaterThan(0);
                    area += signedArea;
                    expect(dot(cross(sub(b.slice(0, 3) as Vec3, a.slice(0, 3) as Vec3), sub(c.slice(0, 3) as Vec3, a.slice(0, 3) as Vec3)), sub(a.slice(0, 3) as Vec3, p.center))).toBeGreaterThan(0);
                }
                expect(area).toBeCloseTo(1, 9);
            }
        }
    });
});

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

    it("goes deep enough for sub-meter ground under your feet", () => {
        for (const p of PLANETS) {
            const L = maxLevelFor(p);
            const chunk = nodeParamSize(L) * p.radius * Math.PI / 4;
            const cell = chunk / (chunkVerticesFor(p, L) - 1);
            // Leaf chunks tens of meters across, with vertices a few tens of centimeters apart.
            expect(chunk).toBeGreaterThan(8);
            expect(chunk).toBeLessThan(40);
            expect(cell).toBeLessThan(0.5);
            expect(finestSpacing(p)).toBe(cell);
        }
    });

    it("makes mountains a thousand times the walker's height", () => {
        let highest = 0;
        for (let k = 0; k < 20000; k++) {
            const z = 1 - 2 * (k + 0.5) / 20000, r = Math.sqrt(1 - z * z), a = k * 2.39996;
            highest = Math.max(highest, sampleSurface(verdant, [r * Math.cos(a), z, r * Math.sin(a)]).terrain);
        }
        expect(highest).toBeGreaterThan(1000 * 1.8);
        expect(verdant.radius).toBeGreaterThan(20 * highest);
    });
});

describe("chunk meshes", () => {
    const node: ChunkNode = { planet: 0, face: 4, level: 5, ia: 13, ib: 17 };

    it("wind every triangle counter-clockwise from outside (the engine culls back faces), stitched or not", () => {
        for (const stitch of [0, 0b1111, 0b11111111, 0b10100101]) {
            for (const p of [verdant, uniform17]) {
            const mesh = buildChunk(p, { ...node, stitch });
            for (let t = 0; t < mesh.triangles; t++) {
                const [a, b, c] = [0, 1, 2].map(k => vert(mesh, mesh.indexData[t * 3 + k]));
                const n = cross(sub(b, a), sub(c, a));
                const out = normalize(sub(a, verdant.center));
                expect(dot(n, out)).toBeGreaterThan(0);
            }
            }
        }
    });

    it("cover the whole cell whichever edges are stitched", () => {
        // Summed projected area on the face plane is the same with and without stitching.
        const area = (stitch: number) => {
            const mesh = buildChunk(uniform17, { ...node, stitch });
            let s = 0;
            for (let t = 0; t < mesh.triangles; t++) {
                const [a, b, c] = [0, 1, 2].map(k => vert(mesh, mesh.indexData[t * 3 + k]));
                s += length(cross(sub(b, a), sub(c, a))) / 2;
            }
            return s;
        };
        const plain = area(0);
        for (const stitch of [0b0001, 0b1010, 0b1111]) expect(Math.abs(area(stitch) - plain) / plain).toBeLessThan(0.05);
    });

    it("share their border vertices exactly with a same-level neighbour", () => {
        const left = buildChunk(uniform17, node);
        const right = buildChunk(uniform17, { ...node, ia: node.ia + 1 });
        const V = CHUNK_SEGMENTS + 1;
        for (let j = 0; j < V; j++) {
            const p = vert(left, j * V + CHUNK_SEGMENTS);
            const q = vert(right, j * V);
            expect(p).toEqual(q);
        }
    });

    it("keep positions small and exact relative to their origin", () => {
        // What the GPU adds up: relative position + (origin - render origin). Both lie on the
        // position grid and stay far below 2^24 grid steps, so f32 holds them exactly.
        const exactF32 = (x: number) => Math.fround(x) === x && Math.abs(x / POSITION_QUANTUM - Math.round(x / POSITION_QUANTUM)) === 0;
        for (const mesh of [buildChunk(verdant, { ...node, level: maxLevelFor(verdant), ia: 13 << 8, ib: 17 << 8 }), buildChunk(uniform17, node)]) {
            for (const o of mesh.origin) expect(exactF32(o - Math.round(o))).toBe(true);
            for (let i = 0; i < mesh.vertexCount; i++) {
                for (let k = 0; k < 3; k++) {
                    const x = mesh.vertexData[i * VERTEX_FLOATS + k];
                    expect(exactF32(x)).toBe(true);
                }
            }
        }
    });

    it("need no skirts: every vertex lies on the surface", () => {
        const mesh = buildChunk(uniform17, node);
        const V = CHUNK_SEGMENTS + 1;
        expect(mesh.vertexCount).toBe(V * V);
        for (let i = 0; i < mesh.vertexCount; i++) {
            expect(Math.abs(altitudeAboveGround(verdant, vert(mesh, i)))).toBeLessThan(maxRelief(verdant) * 0.2);
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
        expect(leaves.length).toBeLessThan(800);
    });

    it("never overlaps itself", () => {
        const { leaves } = selectChunks(verdant, 0, eye);
        for (let i = 0; i < leaves.length; i++) {
            for (let j = i + 1; j < leaves.length; j++) expect(nodesOverlap(leaves[i], leaves[j])).toBe(false);
        }
    });

    it("is balanced: no chunk touches one more than a level finer or coarser", () => {
        const { leaves } = selectChunks(verdant, 0, eye);
        const index = new LeafIndex(maxLevelFor(verdant));
        for (const l of leaves) index.add(l);
        for (const n of leaves) {
            const s = nodeParamSize(n.level), a0 = -1 + n.ia * s, b0 = -1 + n.ib * s, e = s * 1e-4;
            for (let k = 0; k < 8; k++) {
                const t = ((k + 0.5) / 8) * s;
                for (const [a, b] of [[a0 + t, b0 - e], [a0 + t, b0 + s + e], [a0 - e, b0 + t], [a0 + s + e, b0 + t], [a0 - e, b0 - e], [a0 + s + e, b0 + s + e]]) {
                    const m = index.find(n.face, a, b);
                    if (m) expect(Math.abs(m.level - n.level)).toBeLessThanOrEqual(1);
                }
            }
        }
    });

    // The crack test. Every chunk's outline (the edges used by only one of its triangles) must be
    // matched, point for point and bit for bit, by the chunk on the other side - unless nothing is
    // there (ground below the horizon isn't drawn at all). Covers stitched edges, different levels
    // and cube-face seams.
    it("is watertight: every chunk border is exactly the neighbour's border", () => {
        const half: PlanetDef = { ...verdant, chunkDetail: { mode: "half", leafVertices: 32, levels: 8 } };
        const explicit: PlanetDef = { ...verdant, chunkDetail: { mode: "explicit", verticesPerLevel: [24, 12, 8, 6, 4, 3, 3, 3] } };
        for (const [p, pi, viewer] of [[verdant, 0, eye], [PLANETS[1], 1, surfacePoint(PLANETS[1], normalize([-0.5, 0.2, 0.84]))], [half, 0, eye], [explicit, 0, eye]] as const) {
            const { leaves } = selectChunks(p, pi, viewer as Vec3);
            const index = new LeafIndex(maxLevelFor(p));
            for (const l of leaves) index.add(l);
            const key = (v: Vec3) => `${v[0]},${v[1]},${v[2]}`;
            const borders = new Map<string, { node: ChunkNode; from: number; to: number; data: number[] }>();
            let stitchedEdges = 0;
            for (const n of leaves) {
                const mesh = buildChunk(p, n);
                const count = new Map<string, number>();
                const undirected = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
                for (let t = 0; t < mesh.indexData.length; t += 3) {
                    for (let e = 0; e < 3; e++) {
                        const u = undirected(mesh.indexData[t + e], mesh.indexData[t + (e + 1) % 3]);
                        count.set(u, (count.get(u) ?? 0) + 1);
                    }
                }
                for (let t = 0; t < mesh.indexData.length; t += 3) {
                    for (let e = 0; e < 3; e++) {
                        const a = mesh.indexData[t + e], b = mesh.indexData[t + (e + 1) % 3];
                        if (count.get(undirected(a, b)) !== 1) continue;
                        borders.set(`${key(vert(mesh, a))}>${key(vert(mesh, b))}`, { node: n, from: a, to: b, data: mesh.vertexData });
                    }
                }
                if (n.stitch) stitchedEdges++;
            }
            expect(stitchedEdges).toBeGreaterThan(10);
            let matched = 0;
            for (const [k, edge] of borders) {
                const [from, to] = k.split(">");
                if (borders.has(`${to}>${from}`)) { matched++; continue; }
                // Unmatched is only allowed where no chunk is on the other side.
                const n = edge.node, s = nodeParamSize(n.level);
                const uv = (i: number) => [Math.round((edge.data[i * VERTEX_FLOATS + 6] % 1 - 0.001) / 0.99 * CHUNK_SEGMENTS), Math.round((edge.data[i * VERTEX_FLOATS + 7] - n.level - 0.001) / 0.99 * CHUNK_SEGMENTS)];
                const [i0, j0, i1, j1] = [...uv(edge.from), ...uv(edge.to)];
                const mi = (i0 + i1) / 2 / CHUNK_SEGMENTS, mj = (j0 + j1) / 2 / CHUNK_SEGMENTS;
                const out = 1e-4 * s;
                const a = -1 + n.ia * s + mi * s + (i0 === 0 && i1 === 0 ? -out : i0 === CHUNK_SEGMENTS && i1 === CHUNK_SEGMENTS ? out : 0);
                const b = -1 + n.ib * s + mj * s + (j0 === 0 && j1 === 0 ? -out : j0 === CHUNK_SEGMENTS && j1 === CHUNK_SEGMENTS ? out : 0);
                expect(index.find(n.face, a, b), `crack at ${p.name} ${JSON.stringify(n)} edge ${i0},${j0}-${i1},${j1}`).toBeUndefined();
            }
            expect(matched).toBeGreaterThan(1000);
        }
    }, 180_000);

    it("carries neighbour lookups across cube edges", () => {
        // Just past face 0's a = 1 edge is face 5 near its a = -1 edge.
        const [f, a, b] = wrapFace(0, 1.001, 0.25);
        expect(f).toBe(5);
        expect(a).toBeCloseTo(-1 + 0.001, 2);
        expect(b).toBeCloseTo(0.25, 2);
    });

    it("from deep space is a handful of coarse chunks per planet", () => {
        const far: Vec3 = [260_000, 45_000, -170_000];
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
    }, 60_000);

    it("clears every chunk it made", () => {
        const live = new Set<string>();
        const streamer = new PlanetStreamer(PLANETS, { create: id => { live.add(id); }, destroy: id => { live.delete(id); } });
        streamer.update([0, 0, 300_000], 1000, 1e9);
        expect(live.size).toBeGreaterThan(0);
        streamer.clear();
        expect(live.size).toBe(0);
        expect(chunkKey({ planet: 1, face: 2, level: 3, ia: 4, ib: 5 })).toBe("qp-1-2-3-4-5-0");
        expect(chunkKey({ planet: 1, face: 2, level: 3, ia: 4, ib: 5, stitch: 9 })).toBe("qp-1-2-3-4-5-9");
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
        expect(sampleSurface(verdant, d, finestSpacing(verdant) / 2)).toEqual(sampleSurface(verdant, d, finestSpacing(verdant)));
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
        expect(rough(80)).toBeLessThan(rough(finestSpacing(verdant)) * 0.7);
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
            const [a, b, c] = [0, 1, 2].map(k => vert(sky, sky.indexData[t + k]));
            const n = cross(sub(b, a), sub(c, a));
            if (length(n) < 1e-9) continue;
            total++;
            if (dot(n, a) < 0) inward++;
        }
        expect(inward).toBe(total);
    });
});
