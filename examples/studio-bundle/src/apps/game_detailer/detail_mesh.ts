// Geometry the Detailer makes itself, packed in the engine's `mesh` layout exactly as Mesha packs
// its objects (mesha_scene.ts packVertices: the normal's length is 1 + a surface pattern id, color
// is sRGB with roughness in alpha), so one shader draws Mesha objects, the ground and the water:
//
// - ground tiles: a grid of the Ground's heights and colors, with skirts so tiles of different
//   resolution never show cracks between them;
// - water: the sea at sea level under a tile that dips below it, and river ribbons;
// - builtins: wall segments, wells and docks (footprints the library has no object for);
// - levels of detail for Mesha objects: vertex clustering (The Abyss's `cluster`), keeping each
//   vertex's pattern and color, and dropping interiors (Allegiance's exterior-only far houses).
//
// Pure: tested without the engine, and the same code runs in the evaluation worker.

import { cluster, concat, packEvaluation, type PackedMesh } from "../../games/abyss/ab_models";
import { INTERIOR_REGIONS } from "../quadplanet/qp_city";
import { lookupObject } from "../mesha/library";
import { evaluateObject, type ParamValues } from "../mesha/mesha_object";
import { roundedBox, cylinder } from "../mesha/mesha_primitives";
import { bounds as meshBounds, transformMesh, compose4, type Mesh } from "../mesha/mesha_mesh";
import { packVertices } from "../mesha/mesha_scene";
import { material } from "../mesha/mesha_materials";
import type { Ground } from "./detail_ground";
import type { BuiltinShape } from "./detail_scene";

export type { PackedMesh };

/** Surface patterns the Detailer's shader adds to Mesha's (detail_shader.ts). */
export const PATTERN_GROUND = 30;
export const PATTERN_WATER = 31;

/** The render frame: meters from an origin in world km; x east, y up, z south. */
export interface RenderOrigin { x: number; y: number }

export const toRender = (o: RenderOrigin, xKm: number, yKm: number): [number, number] => [(xKm - o.x) * 1000, -(yKm - o.y) * 1000];
export const fromRender = (o: RenderOrigin, rx: number, rz: number): [number, number] => [o.x + rx / 1000, o.y - rz / 1000];

// -------------------------------------------------------------------------------------------------
// Ground tiles
// -------------------------------------------------------------------------------------------------

export interface GroundTile extends PackedMesh {
    /** A water surface for this tile (the sea), if any of it is below sea level. */
    water: PackedMesh | null;
    minY: number;
    maxY: number;
}

/**
 * One tile of ground: `res` x `res` quads over `[x0, x0 + sizeKm] x [y0, y0 + sizeKm]` (world km),
 * relative to `origin`. Skirts hang `skirtM` below the edges.
 */
export function buildGroundTile(ground: Ground, origin: RenderOrigin, x0: number, y0: number, sizeKm: number, res: number, skirtM = 6): GroundTile {
    const n = res + 1;
    const step = sizeKm / res;
    // Heights on an apron one sample wider than the tile, for normals at its edges.
    const H = new Float64Array((n + 2) * (n + 2));
    const colors: Array<[number, number, number, number]> = new Array(n * n);
    let minY = Infinity, maxY = -Infinity, belowSea = false;
    for (let j = -1; j <= n; j++) {
        for (let i = -1; i <= n; i++) {
            const x = x0 + i * step, y = y0 + j * step;
            const inside = i >= 0 && j >= 0 && i < n && j < n;
            const s = ground.sample(x, y, inside);
            H[(j + 1) * (n + 2) + (i + 1)] = s.h;
            if (inside) {
                const c = s.surface!;
                colors[j * n + i] = [c.color[0], c.color[1], c.color[2], 0.49 * c.roughness];
                minY = Math.min(minY, s.h); maxY = Math.max(maxY, s.h);
                if (s.h < ground.seaLevelM) belowSea = true;
            }
        }
    }
    const stepM = step * 1000;
    const verts: number[] = [];
    const idx: number[] = [];
    const scale = 1 + PATTERN_GROUND;
    const push = (i: number, j: number, dropM: number) => {
        const at = (ii: number, jj: number) => H[(jj + 1) * (n + 2) + (ii + 1)];
        const h = at(i, j);
        // y grows north: the render z of the next row is smaller.
        const dhx = (at(i + 1, j) - at(i - 1, j)) / (2 * stepM);
        const dhz = -(at(i, j + 1) - at(i, j - 1)) / (2 * stepM);
        let nx = -dhx, ny = 1, nz = -dhz;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const slope = (Math.acos(Math.max(-1, Math.min(1, ny))) * 180) / Math.PI;
        const c = colors[j * n + i];
        const rgb = ground.rockFor(slope, [c[0], c[1], c[2]]);
        const [rx, rz] = toRender(origin, x0 + i * step, y0 + j * step);
        verts.push(rx, h - dropM, rz, nx * scale, ny * scale, nz * scale, rx * 0.25, rz * 0.25, rgb[0], rgb[1], rgb[2], c[3]);
        return verts.length / 12 - 1;
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) push(i, j, 0);
    for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            // Counter-clockwise seen from above (+y): rows run toward -z.
            idx.push(a, b, d, a, d, c);
        }
    }
    // Skirts: each edge's vertices again, dropped, stitched to the edge.
    const edge = (list: number[][], flip: boolean) => {
        const top = list.map(([i, j]) => j * n + i);
        const bottom = list.map(([i, j]) => push(i, j, skirtM));
        for (let k = 0; k < top.length - 1; k++) {
            if (flip) idx.push(top[k], bottom[k + 1], top[k + 1], top[k], bottom[k], bottom[k + 1]);
            else idx.push(top[k], top[k + 1], bottom[k + 1], top[k], bottom[k + 1], bottom[k]);
        }
    };
    const range = (k: number) => Array.from({ length: k }, (_, t) => t);
    // Outward faces: the south edge faces +z, the north -z, the west -x, the east +x.
    edge(range(n).map((i) => [i, 0]), true);
    edge(range(n).map((i) => [i, n - 1]), false);
    edge(range(n).map((j) => [0, j]), false);
    edge(range(n).map((j) => [n - 1, j]), true);
    const vertexData = Float32Array.from(verts);
    const tile: GroundTile = { vertexData, indexData: Uint32Array.from(idx), bounds: boundsOf(vertexData), triangles: idx.length / 3, water: null, minY, maxY };
    if (belowSea) tile.water = waterQuad(origin, x0, y0, sizeKm, ground.seaLevelM);
    return tile;
}

function boundsOf(v: Float32Array): [number, number, number, number] {
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (let i = 0; i < v.length; i += 12) {
        lx = Math.min(lx, v[i]); hx = Math.max(hx, v[i]);
        ly = Math.min(ly, v[i + 1]); hy = Math.max(hy, v[i + 1]);
        lz = Math.min(lz, v[i + 2]); hz = Math.max(hz, v[i + 2]);
    }
    if (lx === Infinity) return [0, 0, 0, 0];
    return [(lx + hx) / 2, (ly + hy) / 2, (lz + hz) / 2, Math.hypot(hx - lx, hy - ly, hz - lz) / 2];
}

const WATER_RGB: [number, number, number] = [0.1, 0.22, 0.27];

function waterVertex(out: number[], x: number, y: number, z: number): void {
    const s = 1 + PATTERN_WATER;
    out.push(x, y, z, 0, s, 0, x * 0.05, z * 0.05, WATER_RGB[0], WATER_RGB[1], WATER_RGB[2], 0.49 * 0.05);
}

export function waterQuad(origin: RenderOrigin, x0: number, y0: number, sizeKm: number, levelM: number): PackedMesh {
    const v: number[] = [];
    const [ax, az] = toRender(origin, x0, y0), [bx, bz] = toRender(origin, x0 + sizeKm, y0 + sizeKm);
    waterVertex(v, ax, levelM, az); waterVertex(v, bx, levelM, az); waterVertex(v, bx, levelM, bz); waterVertex(v, ax, levelM, bz);
    const vertexData = Float32Array.from(v);
    return { vertexData, indexData: Uint32Array.from([0, 1, 2, 0, 2, 3]), bounds: boundsOf(vertexData), triangles: 2 };
}

/** A river's water: a flat-across ribbon following the bed's level. */
export function riverRibbon(origin: RenderOrigin, points: Array<[number, number]>, halfWidthKm: number, levels: number[]): PackedMesh | null {
    if (points.length < 2) return null;
    const v: number[] = [], idx: number[] = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const w = halfWidthKm * 1.25;
        const [lx, lz] = toRender(origin, points[i][0] - dy * w, points[i][1] + dx * w);
        const [rx, rz] = toRender(origin, points[i][0] + dy * w, points[i][1] - dx * w);
        waterVertex(v, lx, levels[i], lz);
        waterVertex(v, rx, levels[i], rz);
        if (i > 0) {
            const k = i * 2;
            idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
        }
    }
    // Wind both ways: a ribbon can turn either way, and the shader shades both faces.
    const n = idx.length;
    for (let t = 0; t < n; t += 3) idx.push(idx[t], idx[t + 2], idx[t + 1]);
    const vertexData = Float32Array.from(v);
    return { vertexData, indexData: Uint32Array.from(idx), bounds: boundsOf(vertexData), triangles: idx.length / 3 };
}

// -------------------------------------------------------------------------------------------------
// Builtins
// -------------------------------------------------------------------------------------------------

function packMesh(mesh: Mesh, materialId: string): PackedMesh {
    // Stand it on y = 0.
    const b = meshBounds(mesh);
    const m = b ? transformMesh(mesh, compose4([0, -b.min[1], 0])) : mesh;
    const parts = m.parts.map((p) => packVertices({ region: p.region, material: material(materialId), positions: p.positions, normals: p.normals, uvs: p.uvs, indices: p.indices }));
    return concat(parts);
}

/** A builtin's mesh, in its own frame (x along its length, standing on y = 0, front +z). */
export function builtinMesh(shape: BuiltinShape): PackedMesh {
    // Built at the size its cache key names (half-meter steps), so equal keys are equal meshes.
    const [w, h, d] = quantizedSize(shape);
    switch (shape.kind) {
        case "wall": {
            const body = packMesh(roundedBox([w, h, d], 0.05, 1, "wall"), "stone.granite");
            // Crenellations along the top.
            const merlons: PackedMesh[] = [body];
            const count = Math.max(1, Math.floor(w / 2.4));
            for (let i = 0; i < count; i++) {
                const mx = -w / 2 + (i + 0.5) * (w / count);
                const m = packMesh(transformMesh(roundedBox([1.1, 0.9, d * 0.9], 0.04, 1, "wall"), compose4([0, 0, 0])), "stone.granite");
                for (let k = 0; k < m.vertexData.length; k += 12) { m.vertexData[k] += mx; m.vertexData[k + 1] += h; }
                merlons.push(m);
            }
            return concat(merlons);
        }
        case "well": {
            const r = Math.max(0.6, Math.min(w, d) / 2);
            const ring = packMesh(cylinder(r, h, 20, "stone", 0.05), "masonry.fieldstone");
            const water = packMesh(cylinder(r * 0.8, 0.05, 16, "water"), "stone.dark");
            for (let k = 0; k < water.vertexData.length; k += 12) water.vertexData[k + 1] += h - 0.25;
            return concat([ring, water]);
        }
        case "dock":
            return packMesh(roundedBox([w, 0.4, d], 0.03, 1, "deck"), "wood.weathered");
        default:
            return packMesh(cylinder(0.3, 2, 8, "marker"), "paint.red");
    }
}

// -------------------------------------------------------------------------------------------------
// Mesha objects at levels of detail
// -------------------------------------------------------------------------------------------------

export interface ModelLods {
    lods: PackedMesh[];
    /** Bounding sphere in the model's own frame. */
    center: [number, number, number];
    radius: number;
    ms: number;
}

/**
 * Evaluates a Mesha object and makes its levels of detail: the full mesh, then coarser copies by
 * vertex clustering at cells of 3% and 9% of its size, interiors dropped from both (nobody sees
 * into a house from 80 m). `lodCount` 1 skips the coarse copies.
 */
export function buildModelLods(objectId: string, values: ParamValues, lodCount = 3): ModelLods {
    const def = lookupObject(objectId);
    if (!def) throw new Error(`No Mesha object "${objectId}"`);
    const started = Date.now();
    const e = evaluateObject(def, values, lookupObject);
    const full = packEvaluation(e);
    const radius = Math.max(0.05, full.bounds[3]);
    const lods: PackedMesh[] = [full];
    if (lodCount > 1) {
        const outside = packEvaluation(e, (region) => !INTERIOR_REGIONS.has(region));
        const base = outside.triangles > 0 ? outside : full;
        lods.push(cluster(base, radius * 0.03));
        if (lodCount > 2) lods.push(cluster(base, radius * 0.09));
    }
    return { lods, center: [full.bounds[0], full.bounds[1], full.bounds[2]], radius, ms: Date.now() - started };
}

/** A stable cache key for a model variant at a level of detail. */
export function variantKey(objectId: string, values: ParamValues, lod: number): string {
    const sorted = Object.keys(values).sort().map((k) => `${k}=${values[k]}`).join(",");
    return `gd2|${objectId}|${sorted}|lod${lod}`;
}

export function quantizedSize(shape: BuiltinShape): [number, number, number] {
    const q = (v: number) => Math.max(0.5, Math.round(v * 2) / 2);
    return [q(shape.size[0]), q(shape.size[1]), q(shape.size[2])];
}

export function builtinKey(shape: BuiltinShape): string {
    return `gd2|builtin:${shape.kind}|${quantizedSize(shape).join("x")}|lod0`;
}
