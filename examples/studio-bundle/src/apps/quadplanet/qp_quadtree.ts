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
// ground, where a leaf cell is under a meter across.
//
// Crack prevention. QuadScape's fix is that neighbouring tiles agree exactly on their shared
// border (the border samples come from the full-resolution heightmap). The same rule holds here,
// but a planet chunk is always a 16x16 grid, so a chunk one level coarser is twice as big and has
// half as many vertices along a shared edge - and, since coarse chunks sample smoother
// (band-limited) terrain, different heights too. So:
//
//   1. The tree is kept 2:1 balanced: no chunk touches (by an edge or a corner) a chunk more than
//      one level finer or coarser. `balance` splits chunks until that holds.
//   2. Where a chunk borders a coarser neighbour, that edge is "stitched": the finer chunk uses
//      only every other vertex on it - exactly the coarse chunk's vertices - and triangulates
//      around the skipped ones. Both chunks then draw the same edge segments between the same
//      points, with no T-junctions.
//   3. Every vertex on a chunk border is sampled at the band limit of the coarsest chunk touching
//      that point, with a normal computed the same way, so neighbours agree on its position and
//      shading. All grid coordinates are exact binary fractions, so "the same point" is the same
//      floating-point number on both sides, even across cube faces.
//
// The stitch pattern is part of a chunk's key: when a neighbour changes level, the chunk is
// rebuilt to match.
//
// Streaming keeps coverage hole-free: a chunk that is no longer wanted stays live until every
// wanted chunk overlapping it (its replacement children, or its replacing parent) has been built.

import { type Vec3, add, addScaled, cross, distance, dot, length, normalize, scale, sub } from "./qp_math";
import {
    type PlanetDef, CHUNK_SEGMENTS, maxLevelFor, levelWorldSize, levelSpacing, maxRelief, sampleSurface, surfaceColor, surfaceNormal,
} from "./qp_planet";
import { Simplex3 } from "./qp_noise";

export { CHUNK_SEGMENTS, maxLevelFor };

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

/** Edges of a chunk, in stitch-bit order. */
export const EDGE_B_MIN = 0, EDGE_B_MAX = 1, EDGE_A_MIN = 2, EDGE_A_MAX = 3;

export interface ChunkNode {
    planet: number;
    face: number;
    level: number;
    /** Integer cell index along a / b at this level (0 .. 2^level - 1). */
    ia: number;
    ib: number;
    /**
     * Which borders meet a coarser chunk: bits 0-3 are the edges (EDGE_*), bits 4-7 the corners
     * (a-min/b-min, a-max/b-min, a-min/b-max, a-max/b-max). Set by selectChunks.
     */
    stitch?: number;
}

export const chunkKey = (n: ChunkNode): string => `qp-${n.planet}-${n.face}-${n.level}-${n.ia}-${n.ib}-${n.stitch ?? 0}`;

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

function cubePoint(face: number, a: number, b: number): Vec3 {
    const f = FACES[face];
    return [
        f.n[0] + f.a[0] * a + f.b[0] * b,
        f.n[1] + f.a[1] * a + f.b[1] * b,
        f.n[2] + f.a[2] * a + f.b[2] * b,
    ];
}

/** Unit direction for face parameters (a, b). */
export function faceDirection(face: number, a: number, b: number): Vec3 {
    return cubeToSphere(cubePoint(face, a, b));
}

/**
 * Face parameters of a point given on `face` but possibly just past its border: such a point
 * is carried over the cube's edge onto the neighbouring face (for neighbour lookups).
 */
export function wrapFace(face: number, a: number, b: number): [number, number, number] {
    if (Math.abs(a) <= 1 && Math.abs(b) <= 1) return [face, a, b];
    const p = cubePoint(face, a, b);
    let m = 0;
    for (let k = 1; k < 3; k++) if (Math.abs(p[k]) > Math.abs(p[m])) m = k;
    const q = scale(p, 1 / Math.abs(p[m]));
    const nf = FACES.findIndex(f => f.n[m] === Math.sign(p[m]));
    return [nf, dot(q, FACES[nf].a), dot(q, FACES[nf].b)];
}

export function nodeCenterDirection(n: ChunkNode): Vec3 {
    const size = nodeParamSize(n.level);
    return faceDirection(n.face, -1 + (n.ia + 0.5) * size, -1 + (n.ib + 0.5) * size);
}

/** Approximate edge length of the node on the planet's surface, world units. */
export function nodeWorldSize(p: PlanetDef, level: number): number {
    return levelWorldSize(p, level);
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
    /** Chunks split to keep the tree 2:1 balanced. */
    balanced: number;
}

// --- The leaf set --------------------------------------------------------------------------------

/** One planet's leaves, findable by any point on the cube. */
export class LeafIndex {
    private map = new Map<number, ChunkNode>();

    constructor(readonly maxLevel: number) {}

    private static id(face: number, level: number, ia: number, ib: number): number {
        return ((level * 6 + face) * 4096 + ia) * 4096 + ib;
    }

    add(n: ChunkNode): void { this.map.set(LeafIndex.id(n.face, n.level, n.ia, n.ib), n); }
    remove(n: ChunkNode): void { this.map.delete(LeafIndex.id(n.face, n.level, n.ia, n.ib)); }
    has(n: ChunkNode): boolean { return this.map.get(LeafIndex.id(n.face, n.level, n.ia, n.ib)) === n; }
    get size(): number { return this.map.size; }
    values(): ChunkNode[] { return [...this.map.values()]; }

    /** The leaf covering face point (a, b), which may lie just past the face's border. */
    find(face: number, a: number, b: number): ChunkNode | undefined {
        const [f, u, v] = wrapFace(face, a, b);
        for (let level = 0; level <= this.maxLevel; level++) {
            const cells = 1 << level;
            const ia = Math.min(cells - 1, Math.max(0, Math.floor(((u + 1) / 2) * cells)));
            const ib = Math.min(cells - 1, Math.max(0, Math.floor(((v + 1) / 2) * cells)));
            const hit = this.map.get(LeafIndex.id(f, level, ia, ib));
            if (hit) return hit;
        }
        return undefined;
    }
}

/** How far outside a node its neighbour probes land, as a fraction of its size. */
const PROBE = 1e-4;

/** Points just outside the node: `perEdge` along each edge, plus the four diagonal corners. */
function probePoints(n: ChunkNode, perEdge: number): [number, number][] {
    const s = nodeParamSize(n.level);
    const a0 = -1 + n.ia * s, b0 = -1 + n.ib * s, e = s * PROBE;
    const out: [number, number][] = [];
    for (let k = 0; k < perEdge; k++) {
        const t = ((k + 0.5) / perEdge) * s;
        out.push([a0 + t, b0 - e], [a0 + t, b0 + s + e], [a0 - e, b0 + t], [a0 + s + e, b0 + t]);
    }
    out.push([a0 - e, b0 - e], [a0 + s + e, b0 - e], [a0 - e, b0 + s + e], [a0 + s + e, b0 + s + e]);
    return out;
}

function children(n: ChunkNode): ChunkNode[] {
    const out: ChunkNode[] = [];
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        out.push({ planet: n.planet, face: n.face, level: n.level + 1, ia: n.ia * 2 + i, ib: n.ib * 2 + j });
    }
    return out;
}

/**
 * Splits leaves until none touches (along an edge or at a corner) a leaf two or more levels
 * finer. Returns how many splits that took.
 */
export function balance(index: LeafIndex): number {
    let splits = 0;
    const queue = index.values();
    while (queue.length) {
        const n = queue.pop()!;
        if (!index.has(n)) continue;
        // Four probes per edge sit in each of the cells two levels down along it, so a neighbour
        // that fine is always hit.
        const neighbours: ChunkNode[] = [];
        let split = false;
        for (const [a, b] of probePoints(n, 4)) {
            const m = index.find(n.face, a, b);
            if (!m) continue;
            neighbours.push(m);
            if (m.level >= n.level + 2) split = true;
        }
        if (!split) continue;
        index.remove(n);
        for (const c of children(n)) { index.add(c); queue.push(c); }
        // The new, finer children may now be too fine for a coarse neighbour: check those again.
        queue.push(...neighbours);
        splits++;
    }
    return splits;
}

/** Sets every leaf's stitch bits from the (balanced) leaf set. */
export function assignStitches(index: LeafIndex): void {
    for (const n of index.values()) {
        const s = nodeParamSize(n.level);
        const a0 = -1 + n.ia * s, b0 = -1 + n.ib * s, e = s * PROBE;
        const coarser = (a: number, b: number) => {
            const m = index.find(n.face, a, b);
            return m !== undefined && m.level < n.level;
        };
        let bits = 0;
        // Edges: the neighbour at the edge's middle (a coarser one covers the whole edge).
        if (coarser(a0 + s / 2, b0 - e)) bits |= 1 << EDGE_B_MIN;
        if (coarser(a0 + s / 2, b0 + s + e)) bits |= 1 << EDGE_B_MAX;
        if (coarser(a0 - e, b0 + s / 2)) bits |= 1 << EDGE_A_MIN;
        if (coarser(a0 + s + e, b0 + s / 2)) bits |= 1 << EDGE_A_MAX;
        // Corners: any of the other chunks meeting there.
        const corners: [number, number, number, number][] = [[a0, b0, -1, -1], [a0 + s, b0, 1, -1], [a0, b0 + s, -1, 1], [a0 + s, b0 + s, 1, 1]];
        corners.forEach(([ca, cb, da, db], k) => {
            if (coarser(ca + da * e, cb - db * e) || coarser(ca - da * e, cb + db * e) || coarser(ca + da * e, cb + db * e)) bits |= 1 << (4 + k);
        });
        n.stitch = bits;
    }
}

/**
 * The chunks one planet should show for a viewer at `viewer`: a depth-first walk of the six face
 * quadtrees, splitting by distance and skipping whatever is hidden below the horizon (a point on
 * the far side can't be seen past the planet's bulge, even from the top of the highest mountain),
 * then balanced 2:1 and stitched so neighbours share their edges exactly.
 */
export function selectChunks(p: PlanetDef, planetIndex: number, viewer: Vec3, lod: LodSettings = DEFAULT_LOD): Selection {
    let hidden = 0;
    const maxLevel = lod.maxLevel?.[planetIndex] ?? maxLevelFor(p);
    const index = new LeafIndex(maxLevel);
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
        const s = sampleSurface(p, dir, levelSpacing(p, n.level));
        const center = addScaled(p.center, dir, p.radius + s.surface);
        const d = Math.max(0, distance(viewer, center) - size * 0.7);
        if (n.level < lod.minLevel || (n.level < maxLevel && d < lod.splitFactor * size)) {
            for (const c of children(n)) visit(c);
        } else {
            index.add(n);
        }
    };
    for (let face = 0; face < 6; face++) visit({ planet: planetIndex, face, level: 0, ia: 0, ib: 0 });
    const balanced = balance(index);
    assignStitches(index);
    return { leaves: index.values(), hidden, balanced };
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
 * Builds one chunk: an (N+1)^2 grid on the sphere displaced by the terrain, with biome vertex
 * colors. Interior vertices are sampled at the chunk's own band limit with normals from their
 * grid neighbours; border vertices at the coarsest band limit of the chunks meeting there, with
 * normals computed from the surface itself, so neighbours agree on them exactly. Stitched edges
 * skip their odd vertices (see the file comment).
 */
export function buildChunk(p: PlanetDef, n: ChunkNode, segments = CHUNK_SEGMENTS): ChunkMesh {
    const N = segments;
    const V = N + 1;
    const size = nodeParamSize(n.level);
    const a0 = -1 + n.ia * size, b0 = -1 + n.ib * size;
    const step = size / N;
    const stitch = n.stitch ?? 0;
    const bit = (k: number) => (stitch >> k) & 1;
    // This chunk's grid spacing in world units: the terrain is sampled band-limited to it.
    const spacing = levelSpacing(p, n.level);
    const coarse = spacing * 2;

    // Band limit of each vertex: the coarsest chunk touching it.
    const bandAt = (i: number, j: number): number => {
        const onA0 = i === 0, onA1 = i === N, onB0 = j === 0, onB1 = j === N;
        if (onA0 && onB0) return bit(4) ? coarse : spacing;
        if (onA1 && onB0) return bit(5) ? coarse : spacing;
        if (onA0 && onB1) return bit(6) ? coarse : spacing;
        if (onA1 && onB1) return bit(7) ? coarse : spacing;
        if (onB0) return bit(EDGE_B_MIN) ? coarse : spacing;
        if (onB1) return bit(EDGE_B_MAX) ? coarse : spacing;
        if (onA0) return bit(EDGE_A_MIN) ? coarse : spacing;
        if (onA1) return bit(EDGE_A_MAX) ? coarse : spacing;
        return spacing;
    };
    // An odd vertex on a stitched edge isn't part of the mesh: the coarse neighbour has none there.
    const skipped = (i: number, j: number): boolean =>
        (j === 0 && i % 2 === 1 && bit(EDGE_B_MIN) === 1) || (j === N && i % 2 === 1 && bit(EDGE_B_MAX) === 1) ||
        (i === 0 && j % 2 === 1 && bit(EDGE_A_MIN) === 1) || (i === N && j % 2 === 1 && bit(EDGE_A_MAX) === 1);

    const pos: Vec3[] = new Array(V * V);
    const dirs: Vec3[] = new Array(V * V);
    const bands: number[] = new Array(V * V);
    const samples = new Array(V * V);
    for (let j = 0; j < V; j++) {
        for (let i = 0; i < V; i++) {
            const k = j * V + i;
            // Exact binary fractions: a shared point is the same number in every chunk.
            const d = faceDirection(n.face, a0 + i * step, b0 + j * step);
            dirs[k] = d;
            if (skipped(i, j)) continue;
            const band = bandAt(i, j);
            const s = sampleSurface(p, d, band);
            bands[k] = band;
            samples[k] = s;
            pos[k] = addScaled(p.center, d, p.radius + s.surface);
        }
    }
    // Skipped vertices sit on the straight coarse edge (they only feed their neighbours' normals).
    for (let j = 0; j < V; j++) {
        for (let i = 0; i < V; i++) {
            const k = j * V + i;
            if (pos[k]) continue;
            const [ka, kb] = j === 0 || j === N ? [k - 1, k + 1] : [k - V, k + V];
            pos[k] = scale(add(pos[ka], pos[kb]), 0.5);
            samples[k] = samples[ka];
            bands[k] = bands[ka];
        }
    }

    const vertexData: number[] = [];
    const jf = p.radius / 9;
    for (let j = 0; j < V; j++) {
        for (let i = 0; i < V; i++) {
            const k = j * V + i;
            const d = dirs[k];
            const s = samples[k];
            const border = i === 0 || j === 0 || i === N || j === N;
            let nn: Vec3;
            if (s.sea) nn = d; // the sea is flat: shade it with the sphere's normal
            else if (border) nn = surfaceNormal(p, d, bands[k], bands[k]);
            else {
                nn = normalize(cross(sub(pos[k + 1], pos[k - 1]), sub(pos[k + V], pos[k - V])));
                if (dot(nn, d) < 0) nn = scale(nn, -1);
            }
            const jitter = jitterNoise.noise(d[0] * jf, d[1] * jf, d[2] * jf);
            const c = surfaceColor(p, s, dot(nn, d), d, jitter, bands[k]);
            const material = s.sea ? (p.frozenSea ? MATERIAL_ICE : MATERIAL_WATER) : MATERIAL_LAND;
            // uv carries (material + u, level + v): the integer parts are the material id and the
            // quadtree level, the fractions the chunk-local grid position (for the LOD debug view).
            const x = pos[k];
            vertexData.push(x[0], x[1], x[2], nn[0], nn[1], nn[2], packChunkUv(material, i / N), packChunkUv(n.level, j / N), c[0], c[1], c[2], 1);
        }
    }

    // Triangulate each 2x2 block of quads as a fan around its (odd, odd) center vertex, walking
    // the block's rim counter-clockwise (seen from outside). A rim midpoint on a stitched edge is
    // left out, so that side becomes one triangle spanning exactly the coarse neighbour's edge.
    const indexData: number[] = [];
    const rim: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
    for (let cj = 1; cj < N; cj += 2) {
        for (let ci = 1; ci < N; ci += 2) {
            const ring: number[] = [];
            for (const [di, dj] of rim) {
                const i = ci + di, j = cj + dj;
                if (skipped(i, j)) continue;
                ring.push(j * V + i);
            }
            const c = cj * V + ci;
            for (let r = 0; r < ring.length; r++) indexData.push(c, ring[r], ring[(r + 1) % ring.length]);
        }
    }

    const mid = Math.floor(V / 2) * V + Math.floor(V / 2);
    return { vertexData, indexData, vertexCount: V * V, triangles: indexData.length / 3, center: pos[mid] };
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
    /** Splits made to keep the tree balanced, this selection. */
    balanced: number;
    /** Live chunks with at least one stitched border. */
    stitched: number;
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
    /** The last selection, reused while the viewer hasn't moved meaningfully. */
    private cache: { viewer: Vec3; wanted: Map<string, ChunkNode>; hidden: number; balanced: number } | null = null;

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
        return { live: 0, wanted: 0, pending: 0, hidden: 0, balanced: 0, stitched: 0, built: 0, destroyed: 0, deepest: this.planets.map(() => 0), perPlanet: this.planets.map(() => 0), triangles: 0 };
    }

    private select(viewer: Vec3) {
        // Selection (with balancing) is not free; a quarter meter of movement can't change it much.
        if (this.cache && distance(this.cache.viewer, viewer) < 0.25) return this.cache;
        const wanted = new Map<string, ChunkNode>();
        let hidden = 0, balanced = 0;
        this.planets.forEach((p, i) => {
            const sel = selectChunks(p, i, viewer, this.lod);
            hidden += sel.hidden;
            balanced += sel.balanced;
            for (const n of sel.leaves) wanted.set(chunkKey(n), n);
        });
        this.cache = { viewer, wanted, hidden, balanced };
        return this.cache;
    }

    /**
     * `maxBuilds` and `maxMs` bound the work per call (chunk building is the expensive part).
     * Returns what happened, and what is still pending.
     */
    update(viewer: Vec3, maxBuilds = 12, maxMs = 14): StreamStats {
        const started = Date.now();
        const { wanted, hidden, balanced } = this.select(viewer);

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
        stats.balanced = balanced;
        stats.pending = [...wanted.keys()].filter(k => !this.live.has(k)).length;
        stats.built = this.builtTotal;
        stats.destroyed = this.destroyedTotal;
        for (const c of this.live.values()) {
            stats.live++;
            stats.perPlanet[c.node.planet]++;
            stats.deepest[c.node.planet] = Math.max(stats.deepest[c.node.planet], c.node.level);
            stats.triangles += c.triangles;
            if (c.node.stitch) stats.stitched++;
        }
        this.lastStats = stats;
        return stats;
    }

    get stats(): StreamStats { return this.lastStats; }

    /** Removes everything (on teardown). */
    clear(): void {
        for (const key of this.live.keys()) this.sink.destroy(key);
        this.live.clear();
        this.cache = null;
    }

    private approxCenter(n: ChunkNode): Vec3 {
        const p = this.planets[n.planet];
        return add(p.center, scale(nodeCenterDirection(n), p.radius));
    }
}
