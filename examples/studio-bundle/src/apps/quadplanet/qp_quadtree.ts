// The QuadScape idea wrapped around a sphere.
//
// QuadScape (src/heightfield_landscapes/QuadTree.rs + QuadScape.rs) streams one flat heightfield:
// a static quadtree over the map, a tile's LOD picked from its distance to the viewer (LOD_RINGS),
// and a per-frame diff of the wanted tiles against the live ones - new tiles are built and
// uploaded, stale ones dropped.
//
// A planet is six of those quadtrees, one per face of a cube, with every grid point pushed out
// onto the sphere (the "spherified cube" mapping keeps cells close to equal-area) and then out
// again by the terrain height. Because the planet is huge compared to the walker, the tree isn't
// a fixed depth: a node splits while the viewer is closer than `splitFactor` times the node's own
// size, so the rings of detail follow the viewer continuously from orbit down to boots on the
// ground, where a leaf cell is about a meter across.
//
// Crack prevention: QuadScape pins every tile's border to the full-resolution samples. On a
// sphere, neighbours can differ by several levels and meet across cube edges, so each chunk
// instead hangs a skirt (a strip folded down toward the planet's center) under its edges. Where
// a coarse chunk meets a finer one, the skirt fills the sliver between them.
//
// Streaming keeps coverage hole-free: a chunk that is no longer wanted stays live until every
// wanted chunk overlapping it (its replacement children, or its replacing parent) has been built.

import { type Vec3, add, addScaled, cross, distance, dot, length, normalize, scale, sub } from "./qp_math";
import { type PlanetDef, maxRelief, sampleSurface, surfaceColor } from "./qp_planet";
import { Simplex3 } from "./qp_noise";

/** Quads per chunk side (a chunk is (N+1)^2 vertices plus its skirt). */
export const CHUNK_SEGMENTS = 16;
/** Floats per vertex: position(3) normal(3) uv(2) color(4) - the engine's `Vertex` layout. */
export const VERTEX_FLOATS = 12;

/**
 * An integer id plus a [0, 1] fraction in one float: id + 0.001 + 0.99 x fraction. The shader
 * reads the id as floor(x + 0.0005), so exact integers (the models' materials) decode too.
 */
export function packChunkUv(id: number, fraction: number): number {
    return id + 0.001 + 0.99 * Math.min(1, Math.max(0, fraction));
}

/** Material ids carried in uv.x, read by the shader. */
export const MATERIAL_LAND = 0;
export const MATERIAL_WATER = 1;
export const MATERIAL_ICE = 2;

/**
 * Cube faces: `n` is the face normal, `a`/`b` span the face so that a x b = n. A grid laid out
 * with a along columns and b along rows is therefore counter-clockwise seen from outside, which
 * is what the engine's back-face culling keeps.
 */
export const FACES: { n: Vec3; a: Vec3; b: Vec3 }[] = [
    { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
    { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
    { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
    { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
    { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
    { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
];

export interface ChunkNode {
    planet: number;
    face: number;
    level: number;
    /** Integer cell index along a / b at this level (0 .. 2^level - 1). */
    ia: number;
    ib: number;
}

export const chunkKey = (n: ChunkNode): string => `qp-${n.planet}-${n.face}-${n.level}-${n.ia}-${n.ib}`;

/** Size of the node in face parameter units (a root face spans [-1, 1], size 2). */
export const nodeParamSize = (level: number): number => 2 / (1 << level);

/** Maps a point on the cube's surface ([-1,1]^3, one coordinate +-1) to the unit sphere. */
export function cubeToSphere(p: Vec3): Vec3 {
    const [x, y, z] = p;
    const x2 = x * x, y2 = y * y, z2 = z * z;
    return normalize([
        x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3)),
        y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3)),
        z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3)),
    ]);
}

/** Unit direction for face parameters (a, b). */
export function faceDirection(face: number, a: number, b: number): Vec3 {
    const f = FACES[face];
    return cubeToSphere([
        f.n[0] + f.a[0] * a + f.b[0] * b,
        f.n[1] + f.a[1] * a + f.b[1] * b,
        f.n[2] + f.a[2] * a + f.b[2] * b,
    ]);
}

export function nodeCenterDirection(n: ChunkNode): Vec3 {
    const size = nodeParamSize(n.level);
    return faceDirection(n.face, -1 + (n.ia + 0.5) * size, -1 + (n.ib + 0.5) * size);
}

/** Approximate edge length of the node on the planet's surface, world units. */
export function nodeWorldSize(p: PlanetDef, level: number): number {
    return nodeParamSize(level) * p.radius * (Math.PI / 4);
}

/** Deepest level, chosen so a leaf cell is about `leafCell` world units across. */
export function maxLevelFor(p: PlanetDef, leafCell = 1.25, segments = CHUNK_SEGMENTS): number {
    return Math.max(1, Math.ceil(Math.log2(nodeWorldSize(p, 0) / (segments * leafCell))));
}

export interface LodSettings {
    /** A node splits while the viewer is closer than splitFactor x its size. */
    splitFactor: number;
    /** Never coarser than this (a whole face as one 16x16 chunk looks faceted from orbit). */
    minLevel: number;
    /** Per-planet deepest level (defaults to maxLevelFor). */
    maxLevel?: number[];
}

export const DEFAULT_LOD: LodSettings = { splitFactor: 1.5, minLevel: 1 };

export interface Selection {
    leaves: ChunkNode[];
    /** Nodes skipped because they are below the viewer's horizon. */
    hidden: number;
}

/**
 * The chunks one planet should show for a viewer at `viewer`: a depth-first walk of the six face
 * quadtrees, splitting by distance and skipping whatever is hidden below the horizon (a point on
 * the far side can't be seen past the planet's bulge, even from the top of the highest mountain).
 */
export function selectChunks(p: PlanetDef, planetIndex: number, viewer: Vec3, lod: LodSettings = DEFAULT_LOD): Selection {
    const leaves: ChunkNode[] = [];
    let hidden = 0;
    const maxLevel = lod.maxLevel?.[planetIndex] ?? maxLevelFor(p);
    const rel = sub(viewer, p.center);
    const rv = Math.max(length(rel), p.radius + 0.5);
    const viewDir = normalize(rel);
    const relief = maxRelief(p);
    // Angle past which the ground can't be seen: the viewer's horizon over the lowest ground that
    // can block the view (a sea is flat at the mean radius), plus how far beyond it a peak of the
    // maximum height still pokes up.
    const lowest = p.hasSea ? p.radius : p.radius - p.continentHeight;
    const horizon = Math.acos(Math.min(1, lowest / rv)) + Math.acos(lowest / (lowest + relief));

    const visit = (n: ChunkNode) => {
        const dir = nodeCenterDirection(n);
        const size = nodeWorldSize(p, n.level);
        const angularRadius = (size * 0.75) / p.radius;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(dir, viewDir))));
        if (angle - angularRadius > horizon) { hidden++; return; }
        const s = sampleSurface(p, dir, size / CHUNK_SEGMENTS);
        const center = addScaled(p.center, dir, p.radius + s.surface);
        const d = Math.max(0, distance(viewer, center) - size * 0.7);
        if (n.level < lod.minLevel || (n.level < maxLevel && d < lod.splitFactor * size)) {
            for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
                visit({ planet: n.planet, face: n.face, level: n.level + 1, ia: n.ia * 2 + i, ib: n.ib * 2 + j });
            }
        } else {
            leaves.push(n);
        }
    };
    for (let face = 0; face < 6; face++) visit({ planet: planetIndex, face, level: 0, ia: 0, ib: 0 });
    return { leaves, hidden };
}

/** True when the two nodes (same planet and face) cover overlapping ground. */
export function nodesOverlap(a: ChunkNode, b: ChunkNode): boolean {
    if (a.planet !== b.planet || a.face !== b.face) return false;
    const [hi, lo] = a.level >= b.level ? [a, b] : [b, a];
    const shift = hi.level - lo.level;
    return (hi.ia >> shift) === lo.ia && (hi.ib >> shift) === lo.ib;
}

// --- Chunk meshes --------------------------------------------------------------------------------

export interface ChunkMesh {
    vertexData: number[];
    indexData: number[];
    vertexCount: number;
    triangles: number;
    /** World-space center of the chunk's surface. */
    center: Vec3;
}

const jitterNoise = new Simplex3(77);

/**
 * Builds one chunk: an (N+1)^2 grid on the sphere displaced by the terrain, normals from the
 * neighbouring grid points (one extra ring is sampled beyond the chunk, so chunks of the same
 * level agree on their shared border's shading), biome vertex colors, and a skirt.
 */
export function buildChunk(p: PlanetDef, n: ChunkNode, segments = CHUNK_SEGMENTS): ChunkMesh {
    const N = segments;
    const G = N + 3; // grid with a one-sample border ring
    const size = nodeParamSize(n.level);
    const a0 = -1 + n.ia * size, b0 = -1 + n.ib * size;
    const step = size / N;
    // This chunk's grid spacing in world units: the terrain is sampled band-limited to it.
    const spacing = nodeWorldSize(p, n.level) / N;
    const pos: Vec3[] = new Array(G * G);
    const dirs: Vec3[] = new Array(G * G);
    const samples = new Array(G * G);
    for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
            const d = faceDirection(n.face, a0 + (i - 1) * step, b0 + (j - 1) * step);
            const s = sampleSurface(p, d, spacing);
            const k = j * G + i;
            dirs[k] = d;
            samples[k] = s;
            pos[k] = addScaled(p.center, d, p.radius + s.surface);
        }
    }

    const vertexData: number[] = [];
    const indexData: number[] = [];
    const jf = p.radius / 9;
    const edgeNormals: Vec3[] = [];
    const edgeColors: number[][] = [];
    // uv carries (material + u, level + v): the integer parts are the material id and the
    // quadtree level, the fractions the chunk-local grid position (for the LOD debug view's
    // per-level colors and chunk outlines). See packChunkUv.
    const push = (x: Vec3, nn: Vec3, material: number, c: number[], u: number, v: number) => {
        vertexData.push(x[0], x[1], x[2], nn[0], nn[1], nn[2], packChunkUv(material, u), packChunkUv(n.level, v), c[0], c[1], c[2], 1);
    };
    for (let j = 1; j <= N + 1; j++) {
        for (let i = 1; i <= N + 1; i++) {
            const k = j * G + i;
            const d = dirs[k];
            let nn = normalize(cross(sub(pos[k + 1], pos[k - 1]), sub(pos[k + G], pos[k - G])));
            if (dot(nn, d) < 0) nn = scale(nn, -1);
            const s = samples[k];
            const jitter = jitterNoise.noise(d[0] * jf, d[1] * jf, d[2] * jf);
            const c = surfaceColor(p, s, dot(nn, d), d, jitter, spacing);
            const material = s.sea ? (p.frozenSea ? MATERIAL_ICE : MATERIAL_WATER) : MATERIAL_LAND;
            // Sea is flat: shade it with the sphere's normal, not the (flat) grid's.
            if (s.sea) nn = d;
            push(pos[k], nn, material, c, (i - 1) / N, (j - 1) / N);
            edgeNormals.push(nn);
            edgeColors.push([c[0], c[1], c[2], material]);
        }
    }
    const V = N + 1;
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
            indexData.push(a, b, c, b, d, c);
        }
    }

    // Skirt: a strip hanging under each edge, drawn from both sides.
    const skirtDepth = nodeWorldSize(p, n.level) * 0.06 + 1.5;
    const edges: number[][] = [[], [], [], []];
    for (let t = 0; t <= N; t++) {
        edges[0].push(t);                 // b = min
        edges[1].push(N * V + t);         // b = max
        edges[2].push(t * V);             // a = min
        edges[3].push(t * V + N);         // a = max
    }
    let next = V * V;
    for (const edge of edges) {
        const base = next;
        for (const vi of edge) {
            const k = (Math.floor(vi / V) + 1) * G + (vi % V) + 1;
            const x = addScaled(pos[k], dirs[k], -skirtDepth);
            const c = edgeColors[vi];
            push(x, edgeNormals[vi], c[3], c, (vi % V) / N, Math.floor(vi / V) / N);
            next++;
        }
        for (let t = 0; t < N; t++) {
            const e0 = edge[t], e1 = edge[t + 1], s0 = base + t, s1 = base + t + 1;
            indexData.push(e0, e1, s0, e1, s1, s0);
            indexData.push(e0, s0, e1, e1, s0, s1);
        }
    }

    const mid = (Math.floor(G / 2)) * G + Math.floor(G / 2);
    return { vertexData, indexData, vertexCount: next, triangles: indexData.length / 3, center: pos[mid] };
}

// --- Streaming -----------------------------------------------------------------------------------

/** Where built chunks go: the addon creates/clears engine meshes; tests record calls. */
export interface ChunkSink {
    create(id: string, node: ChunkNode, mesh: ChunkMesh): void;
    destroy(id: string): void;
}

export interface StreamStats {
    live: number;
    wanted: number;
    pending: number;
    hidden: number;
    built: number;
    destroyed: number;
    /** Deepest level live per planet. */
    deepest: number[];
    /** Live chunk count per planet. */
    perPlanet: number[];
    triangles: number;
}

interface LiveChunk { node: ChunkNode; triangles: number }

/**
 * QuadScape::update for a solar system: every frame, diff the wanted chunk set (all planets)
 * against the live one, build the closest missing chunks within a budget, and drop stale chunks
 * once their area is covered by live replacements.
 */
export class PlanetStreamer {
    readonly live = new Map<string, LiveChunk>();
    private builtTotal = 0;
    private destroyedTotal = 0;
    private lastStats: StreamStats;

    constructor(
        readonly planets: PlanetDef[],
        private sink: ChunkSink,
        public lod: LodSettings = DEFAULT_LOD,
    ) {
        this.lastStats = this.emptyStats();
    }

    maxLevel(planetIndex: number): number {
        return this.lod.maxLevel?.[planetIndex] ?? maxLevelFor(this.planets[planetIndex]);
    }

    private emptyStats(): StreamStats {
        return { live: 0, wanted: 0, pending: 0, hidden: 0, built: 0, destroyed: 0, deepest: this.planets.map(() => 0), perPlanet: this.planets.map(() => 0), triangles: 0 };
    }

    /**
     * `maxBuilds` and `maxMs` bound the work per call (chunk building is the expensive part).
     * Returns what happened, and what is still pending.
     */
    update(viewer: Vec3, maxBuilds = 12, maxMs = 14): StreamStats {
        const started = Date.now();
        const wanted = new Map<string, ChunkNode>();
        let hidden = 0;
        this.planets.forEach((p, i) => {
            const sel = selectChunks(p, i, viewer, this.lod);
            hidden += sel.hidden;
            for (const n of sel.leaves) wanted.set(chunkKey(n), n);
        });

        // Build the closest missing chunks first.
        const missing = [...wanted.entries()].filter(([k]) => !this.live.has(k));
        missing.sort((x, y) => distance(viewer, this.approxCenter(x[1])) - distance(viewer, this.approxCenter(y[1])));
        let built = 0;
        for (const [key, node] of missing) {
            if (built >= maxBuilds || (built > 0 && Date.now() - started > maxMs)) break;
            const mesh = buildChunk(this.planets[node.planet], node);
            this.sink.create(key, node, mesh);
            this.live.set(key, { node, triangles: mesh.triangles });
            built++;
        }

        // Drop stale chunks whose ground is fully covered by live wanted chunks.
        let destroyed = 0;
        const wantedByFace = new Map<string, ChunkNode[]>();
        for (const n of wanted.values()) {
            const f = `${n.planet}:${n.face}`;
            (wantedByFace.get(f) ?? wantedByFace.set(f, []).get(f)!).push(n);
        }
        for (const [key, chunk] of [...this.live]) {
            if (wanted.has(key)) continue;
            const overlapping = (wantedByFace.get(`${chunk.node.planet}:${chunk.node.face}`) ?? []).filter(w => nodesOverlap(w, chunk.node));
            if (overlapping.every(w => this.live.has(chunkKey(w)))) {
                this.sink.destroy(key);
                this.live.delete(key);
                destroyed++;
            }
        }
        this.builtTotal += built;
        this.destroyedTotal += destroyed;

        const stats = this.emptyStats();
        stats.wanted = wanted.size;
        stats.hidden = hidden;
        stats.pending = [...wanted.keys()].filter(k => !this.live.has(k)).length;
        stats.built = this.builtTotal;
        stats.destroyed = this.destroyedTotal;
        for (const c of this.live.values()) {
            stats.live++;
            stats.perPlanet[c.node.planet]++;
            stats.deepest[c.node.planet] = Math.max(stats.deepest[c.node.planet], c.node.level);
            stats.triangles += c.triangles;
        }
        this.lastStats = stats;
        return stats;
    }

    get stats(): StreamStats { return this.lastStats; }

    /** Removes everything (on teardown). */
    clear(): void {
        for (const key of this.live.keys()) this.sink.destroy(key);
        this.live.clear();
    }

    private approxCenter(n: ChunkNode): Vec3 {
        const p = this.planets[n.planet];
        return add(p.center, scale(nodeCenterDirection(n), p.radius));
    }
}
