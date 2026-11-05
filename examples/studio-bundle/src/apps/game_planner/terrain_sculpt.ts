// Terrain editing for the Game World Planner: brushes you drag (raise, lower, smooth, flatten,
// roughen) and strokes you click out (carve a canyon, raise a mountain range, grade a road bed,
// level a plateau or a building pad). Every operation returns a new TerrainGrid, so the model can
// keep one undo step per stroke and every layer (contours, rivers, travel times, spot elevations)
// reads the edited ground.

import type { SculptMode, TerrainGrid, WorldMetadata } from "./planner_types";
import { Noise2D, gridToWorld, sampleTerrain, terrainCellKm, terrainStats, worldToGrid } from "./terrain";

type Meta = Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">;
type Pt = [number, number];

export const BRUSH_MODES: SculptMode[] = ["raise", "lower", "smooth", "flatten", "roughen"];
export const LINE_MODES: SculptMode[] = ["canyon", "ridge", "grade"];
export const AREA_MODES: SculptMode[] = ["plateau"];

export const SCULPT_INFO: Record<SculptMode, { label: string; how: string; kind: "brush" | "line" | "area" }> = {
    raise: { label: "Raise", how: "Drag to build up the ground.", kind: "brush" },
    lower: { label: "Lower", how: "Drag to dig the ground down.", kind: "brush" },
    smooth: { label: "Smooth", how: "Drag to soften bumps and sharp edges.", kind: "brush" },
    flatten: { label: "Flatten", how: "Drag to level the ground to one height (picked where the stroke starts, or set below).", kind: "brush" },
    roughen: { label: "Roughen", how: "Drag to add rocky, broken relief.", kind: "brush" },
    canyon: { label: "Canyon", how: "Click along the canyon's course, Enter to carve. Its floor runs downhill from the first point.", kind: "line" },
    ridge: { label: "Mountain range", how: "Click along the range's spine, Enter to raise it, with peaks and spurs.", kind: "line" },
    grade: { label: "Road bed", how: "Click along a road, Enter to cut and fill an even, gentle bed for it.", kind: "line" },
    plateau: { label: "Plateau / pad", how: "Outline an area, Enter to level it (for a town, a fort, a landing pad).", kind: "area" },
};

export interface BrushOptions {
    mode: SculptMode;
    radiusKm: number;
    /** 0..1. */
    strength: number;
    /** flatten: the height to level to (meters). */
    targetM?: number;
    seed?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
    return t * t * (3 - 2 * t);
};

function finalize(t: TerrainGrid, data: ArrayLike<number>): TerrainGrid {
    const out: number[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] * 10) / 10;
    const { min, max } = terrainStats(out);
    return { cols: t.cols, rows: t.rows, data: out, seaLevelM: t.seaLevelM, minM: min, maxM: max };
}

/** Grid cells within `reachKm` of a world point's bounding box, as [c0, c1, r0, r1]. */
function cellWindow(t: TerrainGrid, meta: Meta, x0: number, y0: number, x1: number, y1: number, reachKm: number): [number, number, number, number] {
    const [ca, ra] = worldToGrid(t, meta, Math.min(x0, x1) - reachKm, Math.max(y0, y1) + reachKm);
    const [cb, rb] = worldToGrid(t, meta, Math.max(x0, x1) + reachKm, Math.min(y0, y1) - reachKm);
    return [clamp(Math.floor(ca), 0, t.cols - 1), clamp(Math.ceil(cb), 0, t.cols - 1), clamp(Math.floor(ra), 0, t.rows - 1), clamp(Math.ceil(rb), 0, t.rows - 1)];
}

/** Soft round brush falloff: 1 at the center, 0 at the rim. */
export function brushFalloff(dKm: number, radiusKm: number): number {
    if (dKm >= radiusKm) return 0;
    const q = 1 - (dKm / radiusKm) ** 2;
    return q * q;
}

/**
 * One brush dab at (x, y). Raise/lower move the ground by up to ~60 m per dab at full strength
 * (scaled down for small brushes so a fine brush is a fine tool); smooth blends toward the local
 * mean; flatten blends toward `targetM`; roughen adds ridged noise.
 */
export function applyBrushDab(t: TerrainGrid, meta: Meta, x: number, y: number, opts: BrushOptions): TerrainGrid {
    const data = Float64Array.from(t.data);
    const src = t.data;
    const r = Math.max(0.05, opts.radiusKm);
    const s = clamp(opts.strength, 0, 1);
    const [c0, c1, r0, r1] = cellWindow(t, meta, x, y, x, y, r);
    const step = 60 * s * clamp(r / 1.5, 0.35, 1.5);
    const noise = opts.mode === "roughen" ? new Noise2D((opts.seed ?? 7) | 0) : null;
    const target = opts.targetM ?? sampleTerrain(t, meta, x, y);
    const { dx, dy } = terrainCellKm(t, meta);
    for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
            const [wx, wy] = gridToWorld(t, meta, col, row);
            const w = brushFalloff(Math.hypot(wx - x, wy - y), r);
            if (w <= 0) continue;
            const k = row * t.cols + col;
            const h = src[k];
            switch (opts.mode) {
                case "raise":
                    data[k] = h + step * w;
                    break;
                case "lower":
                    data[k] = h - step * w;
                    break;
                case "smooth": {
                    let sum = 0, n = 0;
                    for (let dr = -1; dr <= 1; dr++) {
                        for (let dc = -1; dc <= 1; dc++) {
                            const rr = row + dr, cc = col + dc;
                            if (rr < 0 || cc < 0 || rr >= t.rows || cc >= t.cols) continue;
                            sum += src[rr * t.cols + cc];
                            n++;
                        }
                    }
                    data[k] = h + (sum / n - h) * w * clamp(s * 1.2, 0, 1);
                    break;
                }
                case "flatten":
                    data[k] = h + (target - h) * w * clamp(s * 1.1, 0, 1);
                    break;
                case "roughen": {
                    const n = noise!.ridged(wx / (dx * 3), wy / (dy * 3), 3) - 0.5;
                    data[k] = h + n * step * 0.8 * w;
                    break;
                }
                default:
                    break;
            }
        }
    }
    return finalize(t, data);
}

/** Dabs along a dragged stroke, spaced a third of the brush apart. */
export function applyBrushStroke(t: TerrainGrid, meta: Meta, points: Pt[], opts: BrushOptions): TerrainGrid {
    let out = t;
    const spacing = Math.max(0.02, opts.radiusKm * 0.33);
    let last: Pt | null = null;
    for (const p of points) {
        if (last) {
            const d = Math.hypot(p[0] - last[0], p[1] - last[1]);
            const n = Math.floor(d / spacing);
            for (let i = 1; i <= n; i++) {
                const f = (i * spacing) / d;
                out = applyBrushDab(out, meta, last[0] + (p[0] - last[0]) * f, last[1] + (p[1] - last[1]) * f, opts);
            }
            if (n > 0) last = [last[0] + (p[0] - last[0]) * ((n * spacing) / d), last[1] + (p[1] - last[1]) * ((n * spacing) / d)];
        } else {
            out = applyBrushDab(out, meta, p[0], p[1], opts);
            last = p;
        }
    }
    return out;
}

// -------------------------------------------------------------------------------------------------
// Line strokes: distance and position along a polyline
// -------------------------------------------------------------------------------------------------

/** Distance from a point to a polyline and how far along it (km) the nearest point is. */
export function nearestOnPolyline(p: Pt, line: Pt[]): { d: number; s: number; total: number } {
    let best = Infinity, bestS = 0, run = 0;
    for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i];
        const [bx, by] = line[i + 1];
        const vx = bx - ax, vy = by - ay;
        const len2 = vx * vx + vy * vy;
        const len = Math.sqrt(len2);
        const u = len2 > 0 ? clamp(((p[0] - ax) * vx + (p[1] - ay) * vy) / len2, 0, 1) : 0;
        const d = Math.hypot(p[0] - (ax + vx * u), p[1] - (ay + vy * u));
        if (d < best) {
            best = d;
            bestS = run + u * len;
        }
        run += len;
    }
    if (line.length === 1) best = Math.hypot(p[0] - line[0][0], p[1] - line[0][1]);
    return { d: best, s: bestS, total: run };
}

/** `fn(s)` sampled every `stepKm` along a polyline, as a lookup by distance along it. */
function profileAlong(line: Pt[], stepKm: number, fn: (p: Pt) => number): { at: (s: number) => number; values: number[]; step: number; total: number } {
    let total = 0;
    for (let i = 0; i < line.length - 1; i++) total += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    const n = Math.max(1, Math.ceil(total / stepKm));
    const step = total / n || 1;
    const values: number[] = [];
    for (let k = 0; k <= n; k++) values.push(fn(pointAlong(line, k * step)));
    const at = (s: number) => {
        const f = clamp(s / step, 0, n);
        const i = Math.min(n - 1, Math.floor(f));
        if (n === 0) return values[0];
        return values[i] + (values[i + 1] - values[i]) * (f - i);
    };
    return { at, values, step, total };
}

export function pointAlong(line: Pt[], s: number): Pt {
    let run = 0;
    for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i];
        const [bx, by] = line[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        if (run + len >= s || i === line.length - 2) {
            const u = len > 0 ? clamp((s - run) / len, 0, 1) : 0;
            return [ax + (bx - ax) * u, ay + (by - ay) * u];
        }
        run += len;
    }
    return line[0];
}

function movingAverage(values: number[], radius: number): number[] {
    if (radius < 1) return values.slice();
    return values.map((_, i) => {
        let sum = 0, n = 0;
        for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) {
            sum += values[k];
            n++;
        }
        return sum / n;
    });
}

/** Visits every grid cell near a polyline with its distance to it and position along it. */
function aroundLine(t: TerrainGrid, meta: Meta, line: Pt[], reachKm: number, fn: (k: number, d: number, s: number, wx: number, wy: number) => void): void {
    const xs = line.map((p) => p[0]);
    const ys = line.map((p) => p[1]);
    const [c0, c1, r0, r1] = cellWindow(t, meta, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), reachKm);
    for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
            const [wx, wy] = gridToWorld(t, meta, col, row);
            const { d, s } = nearestOnPolyline([wx, wy], line);
            if (d <= reachKm) fn(row * t.cols + col, d, s, wx, wy);
        }
    }
}

export interface CanyonOptions {
    /** Rim to rim (km). */
    widthKm: number;
    /** How far below the surrounding ground the floor lies (m). */
    depthM: number;
    /** 0..1: the floor's share of the width (0.25 default). */
    floorFraction?: number;
    /** 0..1: how sheer the walls are (0.6 default). */
    steepness?: number;
    /** Keep the floor running downhill from the first point, so water could follow it (default true). */
    downhill?: boolean;
    /** Let the floor go below sea level (a fjord); off by default. */
    allowBelowSea?: boolean;
}

/**
 * Carves a canyon (or a gorge, a ravine, a dry riverbed) along a polyline. The floor follows the
 * ground's own profile `depthM` lower, smoothed, and (by default) never climbs, so it drains from
 * the first point to the last. Walls rise from the floor to the rim; the ground is only ever cut.
 */
export function carveCanyon(t: TerrainGrid, meta: Meta, line: Pt[], opts: CanyonOptions): TerrainGrid {
    if (line.length < 2) return t;
    const half = Math.max(0.05, opts.widthKm / 2);
    const floorHalf = half * clamp(opts.floorFraction ?? 0.25, 0, 0.9);
    const steep = clamp(opts.steepness ?? 0.6, 0, 1);
    const { dx } = terrainCellKm(t, meta);
    // The rim: the ground along the course, averaged across the canyon's width so a single bump
    // does not shape the floor.
    const rim = profileAlong(line, dx * 0.75, (p) => sampleTerrain(t, meta, p[0], p[1]));
    let floor = movingAverage(rim.values, Math.max(1, Math.round(half / (dx * 0.75)))).map((v) => v - opts.depthM);
    if (opts.downhill !== false) {
        for (let i = 1; i < floor.length; i++) floor[i] = Math.min(floor[i], floor[i - 1] - 0.05);
    }
    // A canyon through land stays dry: its floor stops just above sea level (where the ground
    // is already under water it is left alone), so it does not flood into a fjord.
    if (opts.allowBelowSea !== true) {
        floor = floor.map((f, i) => (rim.values[i] > t.seaLevelM ? Math.max(f, t.seaLevelM + 2) : f));
    }
    const n = floor.length - 1;
    const floorAt = (s: number) => {
        const f = clamp(s / rim.step, 0, n);
        const i = Math.min(Math.max(0, n - 1), Math.floor(f));
        return n === 0 ? floor[0] : floor[i] + (floor[i + 1] - floor[i]) * (f - i);
    };
    const data = Float64Array.from(t.data);
    // Steeper walls: the wall profile is pushed toward the rim.
    const power = 1.6 - steep * 1.2;
    aroundLine(t, meta, line, half, (k, d, s) => {
        const fl = floorAt(s);
        const wall = Math.pow(smoothstep(floorHalf, half, d), power);
        const target = fl + (t.data[k] - fl) * wall;
        if (target < data[k]) data[k] = target;
    });
    return finalize(t, data);
}

export interface RidgeOptions {
    /** Base to base (km). */
    widthKm: number;
    /** Height added along the spine (m). */
    heightM: number;
    /** 0..1: peaks, saddles and spurs (0.6 default). */
    roughness?: number;
    seed?: number;
}

/**
 * Raises a mountain range along a polyline: a spine of peaks and saddles that tapers at both ends,
 * flanks that fall away with ridged spurs, added on top of the ground so valleys and foothills
 * already there keep their shape.
 */
export function raiseRidge(t: TerrainGrid, meta: Meta, line: Pt[], opts: RidgeOptions): TerrainGrid {
    if (line.length < 2) return t;
    const half = Math.max(0.1, opts.widthKm / 2);
    const rough = clamp(opts.roughness ?? 0.6, 0, 1);
    const seed = (opts.seed ?? 4242) | 0;
    const peaks = new Noise2D(seed);
    const spurs = new Noise2D(seed + 17);
    const { total } = nearestOnPolyline(line[0], line);
    const data = Float64Array.from(t.data);
    aroundLine(t, meta, line, half, (k, d, s, wx, wy) => {
        // Along the spine: peaks and saddles, tapering to foothills at the ends.
        const endTaper = smoothstep(0, Math.min(half * 1.5, total * 0.3), Math.min(s, total - s));
        const peak = 1 - rough * 0.45 + rough * 0.45 * (peaks.fractal(s / Math.max(0.5, half * 1.2), 3.7, 3) + 0.5);
        // Across: a sharp crest falling to the base, with spurs (ridged noise) on the flanks.
        const across = Math.pow(1 - clamp(d / half, 0, 1), 1.6);
        const spur = 1 + rough * 0.55 * (spurs.ridged(wx / (half * 0.55), wy / (half * 0.55), 4) - 0.5) * (1 - across);
        data[k] += opts.heightM * clamp(endTaper, 0.15, 1) * peak * across * Math.max(0, spur);
    });
    return finalize(t, data);
}

export interface GradeOptions {
    /** The flat bed's width (km). */
    widthKm: number;
    /** The blended embankment beyond the bed on each side (km). */
    shoulderKm?: number;
    /** Steepest allowed grade along the bed, rise over run (0.08 default = 8%). */
    maxGrade?: number;
}

/**
 * Cuts and fills an even bed along a road: the ground's profile along the route is smoothed and
 * its grade limited, the bed is set to it (cut through humps, filled over dips), and the shoulders
 * blend back into the land. Water stays water: cells below sea level are left for a bridge.
 */
export function gradeAlongPath(t: TerrainGrid, meta: Meta, line: Pt[], opts: GradeOptions): TerrainGrid {
    if (line.length < 2) return t;
    const bedHalf = Math.max(0.02, opts.widthKm / 2);
    const shoulder = Math.max(0.02, opts.shoulderKm ?? Math.max(0.15, opts.widthKm));
    const maxGrade = Math.max(0.005, opts.maxGrade ?? 0.08);
    const { dx } = terrainCellKm(t, meta);
    const prof = profileAlong(line, dx * 0.5, (p) => sampleTerrain(t, meta, p[0], p[1]));
    let bed = movingAverage(prof.values, Math.max(1, Math.round((0.6 / (dx * 0.5)))));
    // Limit the grade: forward and backward passes cap the change per step.
    const cap = maxGrade * prof.step * 1000;
    for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < bed.length; i++) bed[i] = clamp(bed[i], bed[i - 1] - cap, bed[i - 1] + cap);
        for (let i = bed.length - 2; i >= 0; i--) bed[i] = clamp(bed[i], bed[i + 1] - cap, bed[i + 1] + cap);
    }
    const n = bed.length - 1;
    const bedAt = (s: number) => {
        const f = clamp(s / prof.step, 0, n);
        const i = Math.min(Math.max(0, n - 1), Math.floor(f));
        return n === 0 ? bed[0] : bed[i] + (bed[i + 1] - bed[i]) * (f - i);
    };
    const data = Float64Array.from(t.data);
    aroundLine(t, meta, line, bedHalf + shoulder, (k, d, s) => {
        if (t.data[k] <= t.seaLevelM) return;
        const target = Math.max(t.seaLevelM + 0.5, bedAt(s));
        const w = 1 - smoothstep(bedHalf, bedHalf + shoulder, d);
        data[k] = t.data[k] + (target - t.data[k]) * w;
    });
    return finalize(t, data);
}

export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
}

/** Mean ground height inside a polygon (sampled on the grid), or null when no cell falls inside. */
export function meanHeightInside(t: TerrainGrid, meta: Meta, poly: Pt[]): number | null {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const [c0, c1, r0, r1] = cellWindow(t, meta, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 0);
    let sum = 0, n = 0;
    for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
            const [wx, wy] = gridToWorld(t, meta, col, row);
            if (!pointInPolygon(wx, wy, poly)) continue;
            sum += t.data[row * t.cols + col];
            n++;
        }
    }
    if (n === 0) {
        const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
        const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
        return sampleTerrain(t, meta, cx, cy);
    }
    return sum / n;
}

export interface PlateauOptions {
    /** The level to set (m); the mean ground inside when omitted. */
    targetM?: number;
    /** The blended slope around the edge (km). */
    featherKm?: number;
}

/** Levels the ground inside a polygon (a plateau, a town's footprint, a landing pad) and blends the edge. */
export function flattenArea(t: TerrainGrid, meta: Meta, poly: Pt[], opts: PlateauOptions = {}): TerrainGrid {
    if (poly.length < 3) return t;
    const target = opts.targetM ?? meanHeightInside(t, meta, poly) ?? 0;
    const feather = Math.max(0.01, opts.featherKm ?? 0.4);
    const ring: Pt[] = [...poly, poly[0]];
    const data = Float64Array.from(t.data);
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const [c0, c1, r0, r1] = cellWindow(t, meta, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), feather);
    for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
            const [wx, wy] = gridToWorld(t, meta, col, row);
            const inside = pointInPolygon(wx, wy, poly);
            const d = inside ? 0 : nearestOnPolyline([wx, wy], ring).d;
            if (d > feather) continue;
            const w = inside ? 1 : 1 - smoothstep(0, feather, d);
            const k = row * t.cols + col;
            data[k] = t.data[k] + (target - t.data[k]) * w;
        }
    }
    return finalize(t, data);
}

/** A circle as a polygon, for a building pad around a spot. */
export function circlePolygon(x: number, y: number, radiusKm: number, n = 20): Pt[] {
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        out.push([x + Math.cos(a) * radiusKm, y + Math.sin(a) * radiusKm]);
    }
    return out;
}

export interface SculptSettings {
    mode: SculptMode;
    radiusKm: number;
    strength: number;
    /** flatten / plateau: a set height; when `snapToLandscape` is on it is read from the ground instead. */
    targetM: number;
    snapToLandscape: boolean;
    canyonWidthKm: number;
    canyonDepthM: number;
    canyonSteepness: number;
    ridgeWidthKm: number;
    ridgeHeightM: number;
    ridgeRoughness: number;
    gradeWidthKm: number;
    gradeMaxPercent: number;
    featherKm: number;
    /** Road bed: also lay a road of this kind along it ("none" grades the ground only). */
    layRoad: "none" | "trail" | "road" | "highway";
    /** Canyon: also run a river along its floor. */
    layRiver: boolean;
}

export function defaultSculptSettings(): SculptSettings {
    return {
        mode: "raise",
        radiusKm: 1.2,
        strength: 0.5,
        targetM: 120,
        snapToLandscape: true,
        canyonWidthKm: 1.4,
        canyonDepthM: 260,
        canyonSteepness: 0.7,
        ridgeWidthKm: 4,
        ridgeHeightM: 1400,
        ridgeRoughness: 0.6,
        gradeWidthKm: 0.12,
        gradeMaxPercent: 8,
        featherKm: 0.4,
        layRoad: "road",
        layRiver: false,
    };
}

/** Applies a clicked-out line or area stroke with the given settings. */
export function applyShapeStroke(t: TerrainGrid, meta: Meta, points: Pt[], s: SculptSettings, seed = 4242): TerrainGrid {
    switch (s.mode) {
        case "canyon":
            return carveCanyon(t, meta, points, { widthKm: s.canyonWidthKm, depthM: s.canyonDepthM, steepness: s.canyonSteepness });
        case "ridge":
            return raiseRidge(t, meta, points, { widthKm: s.ridgeWidthKm, heightM: s.ridgeHeightM, roughness: s.ridgeRoughness, seed });
        case "grade":
            return gradeAlongPath(t, meta, points, { widthKm: s.gradeWidthKm, maxGrade: s.gradeMaxPercent / 100 });
        case "plateau":
            return flattenArea(t, meta, points, { targetM: s.snapToLandscape ? undefined : s.targetM, featherKm: s.featherKm });
        default:
            return t;
    }
}
