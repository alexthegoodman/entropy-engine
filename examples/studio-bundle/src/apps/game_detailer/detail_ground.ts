// The ground up close. The Planner's heightfield has a sample every ~100-250 m: right for a map,
// far too coarse to stand on. The Detailer's ground is that heightfield, interpolated with
// Catmull-Rom (bicubic, so hills stay round), plus what the plan says happens to the ground:
//
// - building pads: every footprint sits on level ground (the mean under it), blended into the slope;
// - road beds: roads, trails, highways and town streets are leveled across and smoothed along;
// - river channels: rivers cut a bed, their water drawn just below the banks;
// - plazas, markets and other areas: leveled to their mean;
// - micro-relief: fractal noise of a meter or two, scaled to the cell size and faded out where the
//   plan leveled the ground, so open land isn't a smooth blanket.
//
// It also colors the ground from the plan: painted marks (forest floor, meadow, farmland, sand,
// snow...), roads and streets, plazas, beaches near the sea and rock on steep slopes.
//
// Pure: the same world gives the same ground in the viewport, in placement and in the export.

import type { GameWorld, PathType, TerrainGrid, WorldStructure } from "../game_planner/planner_types";
import { Noise2D, worldToGrid } from "../game_planner/terrain";
import { structureGeometry, isFootprint } from "../game_planner/town_planning";
import { DEFAULT_GROUND, GROUND_KINDS } from "./detail_models";
import type { GroundMaterial, WorldDetail } from "./detail_types";

type P = [number, number];

/** Real widths (m) of the Planner's path types (the Planner's own widths are map strokes). */
export const PATH_WIDTH_M: Record<PathType, number> = { highway: 10, road: 6, trail: 2.5, river: 12, bridge: 6 };
const RIVER_DEPTH_M = 2.2;
const PAD_MARGIN_M = 7;
const ROAD_SHOULDER_M = 5;
const INDEX_CELL_KM = 0.1;

interface LineFeature {
    kind: "road" | "street" | "river" | "wall";
    surface: string;
    points: P[];
    halfWidthKm: number;
    /** Smoothed elevation at each point (road beds follow it). */
    heights: number[];
    bbox: [number, number, number, number];
}

interface AreaFeature {
    kind: "pad" | "area";
    surface: string | null;
    polys: P[][];
    /** Height at the center (m); areas tilt with `slope` (m per km east, north) about `center`. */
    height: number;
    center: P;
    slope: P;
    marginKm: number;
    bbox: [number, number, number, number];
    structureId: string;
}

export interface SurfaceSample {
    color: [number, number, number];
    roughness: number;
    /** What is on the ground here, for scatter: plants keep off roads, buildings and water. */
    occupied: "water" | "road" | "building" | "area" | null;
}

function distToSegmentKm(p: P, a: P, b: P): { d: number; t: number } {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { d: Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t)), t };
}

function insideConvex(p: P, poly: P[]): boolean {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        if (c !== 0) {
            if (sign === 0) sign = Math.sign(c);
            else if (Math.sign(c) !== sign) return false;
        }
    }
    return true;
}

function distToPolyKm(p: P, poly: P[]): number {
    if (insideConvex(p, poly)) return 0;
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSegmentKm(p, poly[i], poly[(i + 1) % poly.length]).d);
    return d;
}

const smooth01 = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
const mix3 = (a: number[], b: number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

export class Ground {
    readonly seaLevelM: number;
    private noise: Noise2D;
    private lines: LineFeature[] = [];
    private areas: AreaFeature[] = [];
    private index = new Map<string, { segs: Array<{ line: LineFeature; i: number }>; areas: AreaFeature[] }>();
    /** Per-sample scratch: each line's nearest segment. */
    private nearest = new Map<LineFeature, { d: number; h: number }>();
    private materials: Record<string, GroundMaterial>;
    /** Micro-relief amplitude (m), from the heightfield's cell size. */
    readonly reliefM: number;
    private overlayKeys: string[];

    constructor(readonly world: GameWorld, detail?: Pick<WorldDetail, "ground">) {
        this.seaLevelM = world.terrain?.seaLevelM ?? world.meta.seaLevelM ?? 0;
        this.noise = new Noise2D((world.meta.seed | 0) + 17);
        this.materials = { ...DEFAULT_GROUND, ...(detail?.ground ?? {}) };
        const t = world.terrain;
        const cellM = t ? (world.meta.worldWidthKm * 1000) / Math.max(1, t.cols - 1) : 200;
        this.reliefM = Math.max(0.6, Math.min(3.5, cellM / 70));
        this.overlayKeys = Object.keys(world.overlay?.layers ?? {}).filter((k) => !k.startsWith("codex:") && this.materials[k]);
        this.buildFeatures();
    }

    // --- The heightfield ---------------------------------------------------------------------------

    /** Bicubic (Catmull-Rom) elevation of the plan's heightfield, meters. */
    baseHeight(x: number, y: number): number {
        const t: TerrainGrid | undefined = this.world.terrain;
        if (!t || !t.data?.length) return this.seaLevelM + 20;
        const [gc, gr] = worldToGrid(t, this.world.meta, x, y);
        const c = Math.max(0, Math.min(t.cols - 1.0001, gc)), r = Math.max(0, Math.min(t.rows - 1.0001, gr));
        const c1 = Math.floor(c), r1 = Math.floor(r), fc = c - c1, fr = r - r1;
        const at = (cc: number, rr: number) => t.data[Math.max(0, Math.min(t.rows - 1, rr)) * t.cols + Math.max(0, Math.min(t.cols - 1, cc))];
        const row = (rr: number) => catmull(at(c1 - 1, rr), at(c1, rr), at(c1 + 1, rr), at(c1 + 2, rr), fc);
        return catmull(row(r1 - 1), row(r1), row(r1 + 1), row(r1 + 2), fr);
    }

    /** Fractal micro-relief (meters, around 0). */
    relief(x: number, y: number): number {
        const xm = x * 1000, ym = y * 1000;
        const n = this.noise.noise(xm / 90, ym / 90) * 0.62 + this.noise.noise(xm / 31 + 7.1, ym / 31 - 3.3) * 0.28 + this.noise.noise(xm / 9 + 1.7, ym / 9 + 9.2) * 0.1;
        return n * this.reliefM;
    }

    /** The ground's height (m) where the plan has leveled it or not. */
    heightAt(x: number, y: number): number {
        return this.sample(x, y, false).h;
    }

    /** Ground height and surface in one pass (terrain chunks want both). */
    sample(x: number, y: number, withSurface = true): { h: number; surface: SurfaceSample | null } {
        let h = this.baseHeight(x, y);
        let reliefKeep = 1;
        let surfaceKey: string | null = null, surfaceW = 0;
        let occupied: SurfaceSample["occupied"] = null;
        const cell = this.index.get(this.key(x, y));
        const p: P = [x, y];
        if (cell) {
            for (const a of cell.areas) {
                if (x < a.bbox[0] || x > a.bbox[2] || y < a.bbox[1] || y > a.bbox[3]) continue;
                let d = Infinity;
                for (const poly of a.polys) d = Math.min(d, distToPolyKm(p, poly));
                if (d > a.marginKm) continue;
                const w = 1 - smooth01(d / a.marginKm);
                const target = a.height + a.slope[0] * (x - a.center[0]) + a.slope[1] * (y - a.center[1]);
                h = h + (target - h) * w;
                reliefKeep = Math.min(reliefKeep, 1 - w);
                if (d === 0) {
                    occupied = a.kind === "pad" ? "building" : "area";
                    if (a.surface && w >= surfaceW) { surfaceKey = a.surface; surfaceW = 1; }
                } else if (a.surface && w * 0.6 > surfaceW) { surfaceKey = a.surface; surfaceW = w * 0.6; }
            }
            const nearest = this.nearest;
            nearest.clear();
            for (const { line, i } of cell.segs) {
                if (line.kind === "wall") continue;
                const sd = distToSegmentKm(p, line.points[i], line.points[i + 1]);
                const prev = nearest.get(line);
                if (!prev || sd.d < prev.d) nearest.set(line, { d: sd.d, h: line.heights[i] + (line.heights[i + 1] - line.heights[i]) * sd.t });
            }
            for (const [l, { d: best, h: bh }] of nearest) {
                const shoulder = (l.kind === "river" ? 8 : ROAD_SHOULDER_M) / 1000;
                const outer = l.halfWidthKm + shoulder;
                if (best > outer) continue;
                const core = best <= l.halfWidthKm;
                const w = core ? 1 : 1 - smooth01((best - l.halfWidthKm) / shoulder);
                if (l.kind === "river") {
                    const bed = Math.min(h, bh) - RIVER_DEPTH_M * (core ? 1 - 0.5 * (best / l.halfWidthKm) ** 2 : 0.5 * w);
                    h = Math.min(h, h + (bed - h) * w);
                    if (core) occupied = "water";
                } else {
                    h = h + (bh - h) * w;
                    if (core && occupied !== "building") occupied = "road";
                }
                reliefKeep = Math.min(reliefKeep, 1 - w * (l.kind === "river" ? 0.6 : 1));
                const sw = core ? 1 : w * 0.5;
                if (sw >= surfaceW) { surfaceKey = l.surface; surfaceW = sw; }
            }
        }
        h += this.relief(x, y) * reliefKeep;
        if (h < this.seaLevelM + 0.15 && occupied === null) occupied = "water";
        if (!withSurface) return { h, surface: null };
        return { h, surface: this.surface(x, y, h, surfaceKey, surfaceW, occupied) };
    }

    /** Slope in degrees, from the ground itself (2 m differences). */
    slopeDeg(x: number, y: number): number {
        const e = 0.002;
        const gx = (this.heightAt(x + e, y) - this.heightAt(x - e, y)) / (2 * e * 1000);
        const gy = (this.heightAt(x, y + e) - this.heightAt(x, y - e)) / (2 * e * 1000);
        return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
    }

    /** Painted density of a mark at a point, bilinear between the overlay's cell centers. */
    markDensity(key: string, x: number, y: number): number {
        const o = this.world.overlay;
        const layer = o?.layers[key];
        if (!o || !layer) return 0;
        const { worldWidthKm: W, worldHeightKm: H } = this.world.meta;
        const fc = ((x + W / 2) / W) * o.cols - 0.5, fr = ((H / 2 - y) / H) * o.rows - 0.5;
        const c0 = Math.floor(fc), r0 = Math.floor(fr), tc = fc - c0, tr = fr - r0;
        const at = (c: number, r: number) => (c < 0 || r < 0 || c >= o.cols || r >= o.rows ? 0 : layer[r * o.cols + c] || 0);
        const top = at(c0, r0) + (at(c0 + 1, r0) - at(c0, r0)) * tc;
        const bot = at(c0, r0 + 1) + (at(c0 + 1, r0 + 1) - at(c0, r0 + 1)) * tc;
        return top + (bot - top) * tr;
    }

    private surface(x: number, y: number, h: number, key: string | null, keyW: number, occupied: SurfaceSample["occupied"]): SurfaceSample {
        const m = this.materials;
        let color: [number, number, number] = [...m.base.color] as [number, number, number];
        let rough = m.base.roughness;
        // Painted marks, with noise breaking up the coarse cell edges.
        const wobble = this.noise.noise(x * 41 + 3.7, y * 41 - 1.3) * 0.18;
        for (const k of this.overlayKeys) {
            const d = Math.max(0, Math.min(1, this.markDensity(k, x, y) * 1.25 + wobble));
            if (d <= 0.02) continue;
            const g = m[k];
            color = mix3(color, g.color, d);
            rough += (g.roughness - rough) * d;
        }
        // Beaches by the sea, the seabed under it.
        const above = h - this.seaLevelM;
        if (above < 2.5) {
            const g = above < 0 ? m.seabed : m.beach;
            const t = above < 0 ? 1 : 1 - above / 2.5;
            color = mix3(color, g.color, t);
            rough += (g.roughness - rough) * t;
        }
        if (key && m[key] && keyW > 0) {
            color = mix3(color, m[key].color, keyW);
            rough += (m[key].roughness - rough) * keyW;
        }
        return { color, roughness: Math.max(0.05, Math.min(1, rough)), occupied };
    }

    /** Rock on steep ground, after the surface (needs the normal, which chunks know). */
    rockFor(slopeDeg: number, color: [number, number, number]): [number, number, number] {
        const t = smooth01((slopeDeg - 30) / 14);
        return t > 0 ? mix3(color, this.materials.cliff.color, t) : color;
    }

    // --- What the plan puts on the ground --------------------------------------------------------

    private key(x: number, y: number): string {
        return `${Math.floor(x / INDEX_CELL_KM)},${Math.floor(y / INDEX_CELL_KM)}`;
    }

    private cellsOf(bbox: [number, number, number, number], visit: (c: { segs: Array<{ line: LineFeature; i: number }>; areas: AreaFeature[] }) => void): void {
        for (let cx = Math.floor(bbox[0] / INDEX_CELL_KM); cx <= Math.floor(bbox[2] / INDEX_CELL_KM); cx++) {
            for (let cy = Math.floor(bbox[1] / INDEX_CELL_KM); cy <= Math.floor(bbox[3] / INDEX_CELL_KM); cy++) {
                const k = `${cx},${cy}`;
                let c = this.index.get(k);
                if (!c) { c = { segs: [], areas: [] }; this.index.set(k, c); }
                visit(c);
            }
        }
    }

    private bboxOf(points: P[], padKm: number): [number, number, number, number] {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        return [x0 - padKm, y0 - padKm, x1 + padKm, y1 + padKm];
    }

    /** Elevations along a line, smoothed so a road bed doesn't follow every bump. */
    private lineHeights(points: P[]): number[] {
        const raw = points.map(([x, y]) => this.baseHeight(x, y));
        const out = raw.slice();
        for (let pass = 0; pass < 3; pass++) {
            for (let i = 1; i < out.length - 1; i++) out[i] = (out[i - 1] + out[i] * 2 + out[i + 1]) / 4;
        }
        return out;
    }

    /** Splits long segments so a bed's height follows the land between far-apart points. */
    private densify(points: P[], stepKm = 0.04): P[] {
        const out: P[] = [];
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1];
            const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / stepKm));
            for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
        }
        if (points.length) out.push(points[points.length - 1]);
        return out;
    }

    private addLine(kind: LineFeature["kind"], surface: string, rawPoints: P[], widthM: number): void {
        if (rawPoints.length < 2) return;
        const points = this.densify(rawPoints);
        const halfWidthKm = widthM / 2000;
        const line: LineFeature = { kind, surface, points, halfWidthKm, heights: kind === "river" ? points.map(([x, y]) => this.baseHeight(x, y)) : this.lineHeights(points), bbox: this.bboxOf(points, halfWidthKm + 0.01) };
        // A river's bed never runs uphill: carry the lowest height so far downstream.
        if (kind === "river") for (let i = 1; i < line.heights.length; i++) line.heights[i] = Math.min(line.heights[i], line.heights[i - 1] + 0.02);
        this.lines.push(line);
        const pad = halfWidthKm + (kind === "river" ? 0.008 : ROAD_SHOULDER_M / 1000) + 0.002;
        for (let i = 0; i < points.length - 1; i++) {
            const bb = this.bboxOf([points[i], points[i + 1]], pad);
            this.cellsOf(bb, (c) => c.segs.push({ line, i }));
        }
    }

    private buildFeatures(): void {
        const w = this.world;
        for (const p of w.paths) {
            const kind = p.pathType === "river" ? "river" : "road";
            const width = p.pathType === "river" ? PATH_WIDTH_M.river * Math.max(0.4, (p.width || 4.5) / 4.5) : PATH_WIDTH_M[p.pathType] ?? 6;
            this.addLine(kind, p.pathType === "river" ? "water" : p.pathType === "bridge" ? "road" : p.pathType, p.points, width);
        }
        for (const s of w.structures ?? []) this.addStructure(s);
    }

    private addStructure(s: WorldStructure): void {
        const g = structureGeometry(s);
        if (s.shape === "street") { this.addLine("street", "street", g.outline, g.lineWidthM || 6); return; }
        if (s.shape === "wall") { this.addLine("wall", "street", g.outline, g.lineWidthM || 4); return; }
        const polys = g.parts.length ? g.parts : [g.outline];
        if (!polys.length || !polys[0].length) return;
        const pts = polys.flat();
        const isArea = !isFootprint(s.shape);
        const surface = GROUND_KINDS.has(s.kind) ? s.kind : isArea ? "plaza" : null;
        let cx = 0, cy = 0;
        for (const [x, y] of pts) { cx += x; cy += y; }
        cx /= pts.length; cy /= pts.length;
        // Samples over the footprint: its corners, its center, and (for areas) a grid inside it.
        const samples: P[] = [...pts, [cx, cy], [cx, cy]];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        if (isArea) for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
            const q: P = [x0 + ((x1 - x0) * i) / 4, y0 + ((y1 - y0) * j) / 4];
            if (polys.some((poly) => insideConvex(q, poly))) samples.push(q);
        }
        const hs = samples.map(([x, y]) => this.baseHeight(x, y));
        const height = hs.reduce((a, b) => a + b, 0) / hs.length;
        // A building stands on a level pad. A plaza, market or field follows the hill on a plane
        // (least squares through the samples), tilted at most 6%: smoothed, not carved into a terrace.
        let slope: P = [0, 0];
        if (isArea && samples.length > 3) {
            let sxx = 0, sxy = 0, syy = 0, sxh = 0, syh = 0;
            samples.forEach(([x, y], i) => { const dx = x - cx, dy = y - cy, dh = hs[i] - height; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxh += dx * dh; syh += dy * dh; });
            const det = sxx * syy - sxy * sxy;
            if (Math.abs(det) > 1e-12) slope = [(sxh * syy - syh * sxy) / det, (syh * sxx - sxh * sxy) / det];
            const grade = Math.hypot(slope[0], slope[1]) / 1000;
            if (grade > 0.06) slope = [(slope[0] * 0.06) / grade, (slope[1] * 0.06) / grade];
        }
        // The blend widens with the cut or fill: a 1:2.5 bank down from (or up to) the surface, so
        // it meets the ground in a bank, not a cliff.
        let maxDiff = 0;
        samples.forEach(([x, y], i) => { maxDiff = Math.max(maxDiff, Math.abs(hs[i] - (height + slope[0] * (x - cx) + slope[1] * (y - cy)))); });
        const marginKm = Math.min(45, Math.max(isArea ? 6 : PAD_MARGIN_M, maxDiff * 2.5)) / 1000;
        const area: AreaFeature = { kind: isArea ? "area" : "pad", surface, polys, height, center: [cx, cy], slope, marginKm, bbox: this.bboxOf(pts, marginKm), structureId: s.id };
        this.areas.push(area);
        this.cellsOf(area.bbox, (c) => c.areas.push(area));
    }

    /** The leveled height under a structure's footprint (where buildings stand). */
    padHeight(structureId: string): number | null {
        return this.areas.find((a) => a.structureId === structureId)?.height ?? null;
    }

    /** Walls (and their smoothed heights) as segments, for the wall builder. */
    wallSegments(): Array<{ a: P; b: P; widthM: number; ha: number; hb: number }> {
        const out: Array<{ a: P; b: P; widthM: number; ha: number; hb: number }> = [];
        for (const l of this.lines) {
            if (l.kind !== "wall") continue;
            for (let i = 0; i < l.points.length - 1; i++) out.push({ a: l.points[i], b: l.points[i + 1], widthM: l.halfWidthKm * 2000, ha: l.heights[i], hb: l.heights[i + 1] });
        }
        return out;
    }

    /** River water surfaces: a ribbon along each river, just under its banks. */
    riverRibbons(): Array<{ points: P[]; halfWidthKm: number; levels: number[] }> {
        return this.lines.filter((l) => l.kind === "river").map((l) => ({ points: l.points, halfWidthKm: l.halfWidthKm, levels: l.heights.map((h) => h - RIVER_DEPTH_M * 0.35) }));
    }
}
