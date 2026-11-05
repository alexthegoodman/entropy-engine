// Town planning: buildings, walls, streets and plazas, planned at the scale of meters on the same
// map as the world. A building is a footprint (rect, round, L, T or U) of a size in meters at a
// center, with a rotation; walls and streets are lines with a width; plazas, fields and districts
// are outlines. The Build tool places them a click at a time (lined up with the nearest street or
// road), and "Lay out" drafts a whole settlement around a spot from its type: streets, a square,
// the inn and temple near the middle, houses along the streets, walls and gates for a city, docks on
// the water for a port, fields around a village. Like the rest of the planner, these are plans:
// shapes for level builders to read, not modeled buildings.

import type { GameWorld, SpotType, StructureKind, StructureShape, WorldSpot, WorldStructure } from "./planner_types";
import { sampleSlopeDeg, sampleTerrain } from "./terrain";

export type RGBA = [number, number, number, number];

export interface StructureKindInfo {
    label: string;
    shape: StructureShape;
    widthM: number;
    depthM: number;
    floors: number;
    color: RGBA;
    /** Lines (walls, streets): width in meters. */
    lineWidthM?: number;
}

export const STRUCTURE_KINDS: Record<StructureKind, StructureKindInfo> = {
    house: { label: "House", shape: "rect", widthM: 10, depthM: 8, floors: 2, color: [0.84, 0.66, 0.48, 1] },
    hall: { label: "Hall", shape: "rect", widthM: 26, depthM: 14, floors: 2, color: [0.9, 0.72, 0.38, 1] },
    inn: { label: "Inn / tavern", shape: "L", widthM: 18, depthM: 14, floors: 2, color: [0.95, 0.6, 0.3, 1] },
    shop: { label: "Shop", shape: "rect", widthM: 9, depthM: 10, floors: 2, color: [0.9, 0.78, 0.45, 1] },
    smithy: { label: "Smithy", shape: "rect", widthM: 12, depthM: 9, floors: 1, color: [0.6, 0.55, 0.55, 1] },
    temple: { label: "Temple / shrine", shape: "T", widthM: 20, depthM: 30, floors: 1, color: [0.85, 0.82, 0.95, 1] },
    keep: { label: "Keep / castle", shape: "rect", widthM: 30, depthM: 30, floors: 4, color: [0.62, 0.66, 0.76, 1] },
    tower: { label: "Tower", shape: "round", widthM: 9, depthM: 9, floors: 4, color: [0.66, 0.7, 0.8, 1] },
    barracks: { label: "Barracks", shape: "rect", widthM: 34, depthM: 11, floors: 2, color: [0.6, 0.62, 0.68, 1] },
    warehouse: { label: "Warehouse", shape: "rect", widthM: 24, depthM: 14, floors: 1, color: [0.7, 0.6, 0.5, 1] },
    workshop: { label: "Workshop", shape: "rect", widthM: 14, depthM: 10, floors: 1, color: [0.75, 0.62, 0.45, 1] },
    farmhouse: { label: "Farmhouse", shape: "L", widthM: 16, depthM: 12, floors: 2, color: [0.8, 0.68, 0.45, 1] },
    barn: { label: "Barn", shape: "rect", widthM: 18, depthM: 10, floors: 1, color: [0.7, 0.4, 0.3, 1] },
    mill: { label: "Mill", shape: "round", widthM: 10, depthM: 10, floors: 3, color: [0.85, 0.8, 0.65, 1] },
    dock: { label: "Dock / pier", shape: "rect", widthM: 8, depthM: 40, floors: 0, color: [0.55, 0.45, 0.35, 1] },
    well: { label: "Well / fountain", shape: "round", widthM: 4, depthM: 4, floors: 0, color: [0.4, 0.7, 0.95, 1] },
    gate: { label: "Gatehouse", shape: "U", widthM: 16, depthM: 10, floors: 3, color: [0.62, 0.66, 0.76, 1] },
    wall: { label: "Wall", shape: "wall", widthM: 0, depthM: 0, floors: 0, color: [0.58, 0.6, 0.66, 1], lineWidthM: 4 },
    street: { label: "Street", shape: "street", widthM: 0, depthM: 0, floors: 0, color: [0.78, 0.72, 0.6, 1], lineWidthM: 6 },
    plaza: { label: "Square / plaza", shape: "area", widthM: 36, depthM: 36, floors: 0, color: [0.82, 0.78, 0.68, 1] },
    market: { label: "Market", shape: "area", widthM: 40, depthM: 30, floors: 0, color: [0.95, 0.75, 0.35, 1] },
    garden: { label: "Garden / park", shape: "area", widthM: 30, depthM: 30, floors: 0, color: [0.45, 0.72, 0.4, 1] },
    field: { label: "Field / pasture", shape: "area", widthM: 120, depthM: 80, floors: 0, color: [0.72, 0.78, 0.4, 1] },
};

export const STRUCTURE_KIND_IDS = Object.keys(STRUCTURE_KINDS) as StructureKind[];
export const FOOTPRINT_SHAPES: StructureShape[] = ["rect", "round", "L", "T", "U"];
export const isFootprint = (shape: StructureShape) => FOOTPRINT_SHAPES.includes(shape);
export const isLine = (shape: StructureShape) => shape === "wall" || shape === "street";

/** Settlement spot types, the ones Lay out drafts a town for and new buildings attach to. */
const SETTLEMENT_TYPES: SpotType[] = ["capital", "city", "town", "village", "port", "fortress", "camp", "mine", "shrine", "ruin"];

export function newStructureId(): string {
    return `bld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const M = 1 / 1000; // meters in km

// -------------------------------------------------------------------------------------------------
// Geometry
// -------------------------------------------------------------------------------------------------

type P = [number, number];

/** Local footprint parts in meters (convex pieces), unrotated, centered on the origin. */
export function localParts(shape: StructureShape, w: number, d: number): P[][] {
    const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const hw = w / 2, hd = d / 2;
    switch (shape) {
        case "round": {
            const n = 16;
            return [Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * hw, Math.sin((i / n) * Math.PI * 2) * hd] as P)];
        }
        case "L": {
            // A front range along the street and a wing going back on the left.
            const wing = Math.max(3, w * 0.42);
            const front = Math.max(3, d * 0.45);
            return [rect(-hw, -hd, hw, -hd + front), rect(-hw, -hd + front, -hw + wing, hd)];
        }
        case "T": {
            // A nave going back and a cross range at the front (a church, a hall with a porch).
            const bar = Math.max(3, d * 0.32);
            const stem = Math.max(3, w * 0.45);
            return [rect(-hw, -hd, hw, -hd + bar), rect(-stem / 2, -hd + bar, stem / 2, hd)];
        }
        case "U": {
            // Two towers and the range joining them (a gatehouse, a courtyard house).
            const arm = Math.max(2.5, w * 0.3);
            const back = Math.max(2.5, d * 0.4);
            return [rect(-hw, hd - back, hw, hd), rect(-hw, -hd, -hw + arm, hd - back), rect(hw - arm, -hd, hw, hd - back)];
        }
        default:
            return [rect(-hw, -hd, hw, hd)];
    }
}

/** The outer outline of a footprint, in local meters. */
export function localOutline(shape: StructureShape, w: number, d: number): P[] {
    const hw = w / 2, hd = d / 2;
    switch (shape) {
        case "round":
            return localParts(shape, w, d)[0];
        case "L": {
            const wing = Math.max(3, w * 0.42), front = Math.max(3, d * 0.45);
            return [[-hw, -hd], [hw, -hd], [hw, -hd + front], [-hw + wing, -hd + front], [-hw + wing, hd], [-hw, hd]];
        }
        case "T": {
            const bar = Math.max(3, d * 0.32), stem = Math.max(3, w * 0.45);
            return [[-hw, -hd], [hw, -hd], [hw, -hd + bar], [stem / 2, -hd + bar], [stem / 2, hd], [-stem / 2, hd], [-stem / 2, -hd + bar], [-hw, -hd + bar]];
        }
        case "U": {
            const arm = Math.max(2.5, w * 0.3), back = Math.max(2.5, d * 0.4);
            return [[-hw, -hd], [-hw + arm, -hd], [-hw + arm, hd - back], [hw - arm, hd - back], [hw - arm, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
        }
        default:
            return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    }
}

/** Local meters (x east, y north before rotation; "front" is -y) to world km. */
export function toWorld(s: Pick<WorldStructure, "x" | "y" | "rotationDeg">, p: P): P {
    const a = (s.rotationDeg * Math.PI) / 180;
    const c = Math.cos(a), sn = Math.sin(a);
    return [s.x + (p[0] * c - p[1] * sn) * M, s.y + (p[0] * sn + p[1] * c) * M];
}

/** Ear clipping for a simple polygon (plazas and fields may be concave). Returns triangles. */
export function triangulate(poly: P[]): P[][] {
    const pts = poly.slice();
    if (pts.length < 3) return [];
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
        area += x0 * y1 - x1 * y0;
    }
    if (area < 0) pts.reverse();
    const cross = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const inside = (p: P, a: P, b: P, c: P) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
    const tris: P[][] = [];
    const idx = pts.map((_, i) => i);
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
        let clipped = false;
        for (let k = 0; k < idx.length; k++) {
            const a = pts[idx[(k + idx.length - 1) % idx.length]], b = pts[idx[k]], c = pts[idx[(k + 1) % idx.length]];
            if (cross(a, b, c) <= 1e-12) continue;
            const blocked = idx.some((j) => {
                const p = pts[j];
                return p !== a && p !== b && p !== c && inside(p, a, b, c);
            });
            if (blocked) continue;
            tris.push([a, b, c]);
            idx.splice(k, 1);
            clipped = true;
            break;
        }
        if (!clipped) break; // degenerate: fall back to a fan of what is left
    }
    if (idx.length >= 3) for (let k = 1; k < idx.length - 1; k++) tris.push([pts[idx[0]], pts[idx[k]], pts[idx[k + 1]]]);
    return tris;
}

export interface StructureGeometry {
    /** Convex pieces to fill, world km. */
    parts: P[][];
    /** The outline (closed for footprints and areas, open for lines), world km. */
    outline: P[];
    closed: boolean;
    /** Lines: their width in meters (0 for footprints and areas). */
    lineWidthM: number;
}

export function structureGeometry(s: WorldStructure): StructureGeometry {
    if (isLine(s.shape)) {
        return { parts: [], outline: s.points ?? [], closed: false, lineWidthM: s.widthM || STRUCTURE_KINDS[s.kind]?.lineWidthM || 4 };
    }
    if (s.shape === "area") {
        const pts = s.points && s.points.length >= 3 ? s.points : localOutline("rect", s.widthM, s.depthM).map((p) => toWorld(s, p));
        return { parts: triangulate(pts), outline: pts, closed: true, lineWidthM: 0 };
    }
    return {
        parts: localParts(s.shape, s.widthM, s.depthM).map((part) => part.map((p) => toWorld(s, p))),
        outline: localOutline(s.shape, s.widthM, s.depthM).map((p) => toWorld(s, p)),
        closed: true,
        lineWidthM: 0,
    };
}

/** Area of the footprint in m² (lines: length x width). */
export function structureAreaM2(s: WorldStructure): number {
    const g = structureGeometry(s);
    if (!g.closed) {
        let len = 0;
        for (let i = 0; i < g.outline.length - 1; i++) len += Math.hypot(g.outline[i + 1][0] - g.outline[i][0], g.outline[i + 1][1] - g.outline[i][1]);
        return len * 1000 * g.lineWidthM;
    }
    let a = 0;
    const o = g.outline;
    for (let i = 0; i < o.length; i++) a += o[i][0] * o[(i + 1) % o.length][1] - o[(i + 1) % o.length][0] * o[i][1];
    return Math.abs(a / 2) * 1e6;
}

/** Moves a structure by a world-km offset (lines and areas move all their points). */
export function translateStructure(s: WorldStructure, dx: number, dy: number): Partial<WorldStructure> {
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
    return {
        x: r4(s.x + dx),
        y: r4(s.y + dy),
        ...(s.points ? { points: s.points.map(([x, y]) => [r4(x + dx), r4(y + dy)] as P) } : {}),
    };
}

// -------------------------------------------------------------------------------------------------
// Placing
// -------------------------------------------------------------------------------------------------

/** The settlement a place belongs to: the nearest settlement-type spot within `km`. */
export function settlementNear(world: GameWorld, x: number, y: number, km = 1.5): WorldSpot | undefined {
    let best: WorldSpot | undefined;
    let bestD = km;
    for (const s of world.spots) {
        if (!SETTLEMENT_TYPES.includes(s.spotType)) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d <= bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}

/** The nearest street (structure) or road segment within `km`, with its direction. */
export function nearestStreet(world: GameWorld, x: number, y: number, km = 0.08): { angleDeg: number; distKm: number; point: P } | null {
    const lines: P[][] = [
        ...(world.structures ?? []).filter((s) => s.shape === "street" && s.points && s.points.length >= 2).map((s) => s.points!),
        ...world.paths.filter((p) => p.pathType !== "river").map((p) => p.points),
    ];
    let best: { angleDeg: number; distKm: number; point: P } | null = null;
    for (const pts of lines) {
        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
            const dx = bx - ax, dy = by - ay;
            const l2 = dx * dx + dy * dy;
            if (l2 <= 0) continue;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
            const px = ax + dx * t, py = ay + dy * t;
            const d = Math.hypot(x - px, y - py);
            if (d <= km && (!best || d < best.distKm)) best = { angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI, distKm: d, point: [px, py] };
        }
    }
    return best;
}

/**
 * The rotation that puts a building's front (local -y) toward the nearest street: its long side
 * runs along the street. null when no street is near.
 */
export function alignToStreet(world: GameWorld, x: number, y: number, km = 0.08): number | null {
    const st = nearestStreet(world, x, y, km);
    if (!st) return null;
    // Local +x runs along the street; flip so local -y (the front) faces the street.
    let rot = st.angleDeg;
    const a = (rot * Math.PI) / 180;
    const front: P = [Math.sin(a), -Math.cos(a)]; // local (0,-1) rotated
    const toStreet: P = [st.point[0] - x, st.point[1] - y];
    if (front[0] * toStreet[0] + front[1] * toStreet[1] < 0) rot += 180;
    return normalizeDeg(rot);
}

export const normalizeDeg = (d: number) => Math.round((((d % 360) + 360) % 360) * 10) / 10;

export interface NewStructureOptions {
    shape?: StructureShape;
    widthM?: number;
    depthM?: number;
    rotationDeg?: number;
    points?: P[];
    name?: string;
    floors?: number;
    spotId?: string;
}

export function createStructure(world: GameWorld, kind: StructureKind, x: number, y: number, opts: NewStructureOptions = {}): WorldStructure {
    const info = STRUCTURE_KINDS[kind] ?? STRUCTURE_KINDS.house;
    const shape = opts.shape ?? info.shape;
    const line = isLine(shape);
    const s: WorldStructure = {
        id: newStructureId(),
        kind,
        shape,
        x: Math.round(x * 1e4) / 1e4,
        y: Math.round(y * 1e4) / 1e4,
        widthM: opts.widthM ?? (line ? info.lineWidthM ?? 4 : info.widthM),
        depthM: opts.depthM ?? (line ? 0 : info.depthM),
        rotationDeg: normalizeDeg(opts.rotationDeg ?? 0),
    };
    if (opts.points) s.points = opts.points.map((p) => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4] as P);
    if (opts.name) s.name = opts.name;
    const floors = opts.floors ?? info.floors;
    if (floors) s.floors = floors;
    const spot = opts.spotId ? world.spots.find((p) => p.id === opts.spotId) : settlementNear(world, x, y);
    if (spot) s.spotId = spot.id;
    return s;
}

/** What a settlement has been planned with: counts by kind, footprint area. */
export function townSummary(world: GameWorld, spotId: string): { total: number; buildings: number; byKind: Array<{ kind: StructureKind; count: number }>; builtAreaM2: number } {
    const list = (world.structures ?? []).filter((s) => s.spotId === spotId);
    const counts = new Map<StructureKind, number>();
    let area = 0;
    let buildings = 0;
    for (const s of list) {
        counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
        if (isFootprint(s.shape)) {
            buildings++;
            area += structureAreaM2(s);
        }
    }
    return {
        total: list.length,
        buildings,
        byKind: [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
        builtAreaM2: Math.round(area),
    };
}

/** Distance in meters from (x, y) to segment a-b (world km). */
function segDistM(x: number, y: number, a: P, b: P): number {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
    return Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t)) * 1000;
}

/** Extra points so no segment is longer than `stepKm` (long road segments still get house slots near town). */
function densify(pts: P[], stepKm: number): P[] {
    const out: P[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepKm));
        for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    out.push(pts[pts.length - 1]);
    return out;
}

// -------------------------------------------------------------------------------------------------
// Laying out a whole settlement
// -------------------------------------------------------------------------------------------------

interface TownProfile {
    radiusM: number;
    streets: number;
    ring: boolean;
    houses: number;
    walls: boolean;
    fields: number;
    landmarks: StructureKind[];
    houseKinds: StructureKind[];
    plaza: StructureKind | null;
}

const PROFILES: Partial<Record<SpotType, TownProfile>> = {
    village: { radiusM: 140, streets: 3, ring: false, houses: 14, walls: false, fields: 4, landmarks: ["inn", "temple", "smithy", "well", "mill"], houseKinds: ["house", "house", "farmhouse", "barn"], plaza: "plaza" },
    town: { radiusM: 250, streets: 4, ring: true, houses: 40, walls: false, fields: 3, landmarks: ["inn", "temple", "hall", "smithy", "shop", "shop", "well", "warehouse"], houseKinds: ["house", "house", "house", "shop", "workshop"], plaza: "market" },
    port: { radiusM: 250, streets: 4, ring: true, houses: 36, walls: false, fields: 0, landmarks: ["inn", "temple", "hall", "warehouse", "warehouse", "shop", "well"], houseKinds: ["house", "house", "warehouse", "shop", "workshop"], plaza: "market" },
    city: { radiusM: 400, streets: 5, ring: true, houses: 90, walls: true, fields: 0, landmarks: ["hall", "temple", "inn", "inn", "smithy", "shop", "shop", "barracks", "well", "garden"], houseKinds: ["house", "house", "house", "shop", "workshop", "warehouse"], plaza: "market" },
    capital: { radiusM: 520, streets: 6, ring: true, houses: 130, walls: true, fields: 0, landmarks: ["keep", "temple", "hall", "inn", "inn", "barracks", "smithy", "shop", "shop", "garden", "well", "well"], houseKinds: ["house", "house", "house", "shop", "workshop", "warehouse"], plaza: "market" },
    fortress: { radiusM: 120, streets: 2, ring: false, houses: 6, walls: true, fields: 0, landmarks: ["keep", "barracks", "smithy", "tower", "well"], houseKinds: ["house", "warehouse"], plaza: "plaza" },
    camp: { radiusM: 60, streets: 2, ring: false, houses: 9, walls: false, fields: 0, landmarks: [], houseKinds: ["house"], plaza: null },
    mine: { radiusM: 90, streets: 2, ring: false, houses: 7, walls: false, fields: 0, landmarks: ["workshop", "warehouse", "smithy"], houseKinds: ["house", "workshop"], plaza: null },
    shrine: { radiusM: 70, streets: 1, ring: false, houses: 4, walls: false, fields: 1, landmarks: ["temple", "well", "garden"], houseKinds: ["house"], plaza: "plaza" },
    ruin: { radiusM: 120, streets: 2, ring: false, houses: 10, walls: true, fields: 0, landmarks: ["tower", "temple"], houseKinds: ["house", "house", "hall"], plaza: null },
};

export function canLayOut(spotType: SpotType): boolean {
    return !!PROFILES[spotType];
}

function rng(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function hashString(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
}

export interface LayoutResult {
    structures: WorldStructure[];
    /** Footprints that were skipped because the ground was water or too steep. */
    skipped: number;
}

/**
 * Drafts a settlement around a spot from its type: radial streets (lined up with a road that
 * reaches it, if any) and a ring street for larger places, a square or market, the important
 * buildings around it, houses along the streets facing them, walls with gatehouses for cities,
 * docks on the shore for ports, fields around villages. Ground under water or steeper than 24
 * degrees is left empty. Deterministic for a spot and a variant number.
 */
export function layOutTown(world: GameWorld, spot: WorldSpot, opts: { variant?: number; scale?: number } = {}): LayoutResult {
    const prof = PROFILES[spot.spotType] ?? PROFILES.village!;
    const rand = rng(hashString(spot.id) + (opts.variant ?? 0) * 7919);
    const scale = Math.max(0.4, Math.min(2.5, opts.scale ?? 1));
    const R = prof.radiusM * Math.sqrt(scale);
    const t = world.terrain;
    const sea = world.meta.seaLevelM;
    const cx = spot.x, cy = spot.y;
    const at = (dxM: number, dyM: number): P => [cx + dxM * M, cy + dyM * M];
    const dry = (p: P) => !t || sampleTerrain(t, world.meta, p[0], p[1]) > sea + 0.5;
    const buildable = (p: P) => dry(p) && (!t || sampleSlopeDeg(t, world.meta, p[0], p[1]) <= 24);
    const out: WorldStructure[] = [];
    const taken: Array<{ x: number; y: number; r: number }> = [];
    let skipped = 0;
    const free = (x: number, y: number, r: number) => taken.every((o) => Math.hypot(o.x - x, o.y - y) * 1000 >= o.r + r);
    const make = (kind: StructureKind, x: number, y: number, o: NewStructureOptions = {}) => createStructure(world, kind, x, y, { ...o, spotId: spot.id });

    // Main direction: along the road that comes closest to the spot, else random.
    const road = nearestStreet(world, cx, cy, R * M * 1.5);
    const baseAngle = road ? road.angleDeg : rand() * 360;
    // Roads (and highways) already running through town: houses line them too, nothing is built on
    // them, and no spoke street is laid along them.
    const roadLines: Array<{ pts: P[]; halfM: number }> = world.paths
        .filter((p) => p.pathType !== "river" && p.points.length >= 2)
        .map((p) => ({ pts: p.points, halfM: Math.max(3, p.width * 1.2) }))
        .filter((r) => r.pts.some((q, i) => i < r.pts.length - 1 && segDistM(cx, cy, q, r.pts[i + 1]) < R * 1.1));
    const onRoad = (x: number, y: number, r: number) => roadLines.some((l) => l.pts.some((q, i) => i < l.pts.length - 1 && segDistM(x, y, q, l.pts[i + 1]) < l.halfM + r));
    // Directions in which roads leave the middle.
    const roadDirs: number[] = [];
    for (const l of roadLines) {
        for (let i = 0; i < l.pts.length - 1; i++) {
            if (segDistM(cx, cy, l.pts[i], l.pts[i + 1]) > 40) continue;
            const a = (Math.atan2(l.pts[i + 1][1] - l.pts[i][1], l.pts[i + 1][0] - l.pts[i][0]) * 180) / Math.PI;
            roadDirs.push(a, a + 180);
        }
    }
    const nearRoadDir = (a: number) => roadDirs.some((d) => Math.abs((((a - d) % 360) + 540) % 360 - 180) < 25);

    // The square.
    const plazaR = prof.plaza ? Math.max(14, R * 0.09) : 0;
    if (prof.plaza) {
        const n = 8;
        const pts: P[] = Array.from({ length: n }, (_, i) => {
            const a = ((i / n) * 360 + baseAngle + 22.5) * (Math.PI / 180);
            return at(Math.cos(a) * plazaR, Math.sin(a) * plazaR);
        });
        out.push(make(prof.plaza, cx, cy, { points: pts, widthM: plazaR * 2, depthM: plazaR * 2 }));
        taken.push({ x: cx, y: cy, r: plazaR });
    }

    // Streets: radial spokes, gently bent, cut short at water.
    const streets: P[][] = [];
    for (let k = 0; k < prof.streets; k++) {
        const a0 = baseAngle + (360 / prof.streets) * k + (rand() - 0.5) * 18;
        if (nearRoadDir(a0)) continue; // the road itself is the street that way
        const pts: P[] = [];
        const steps = 6;
        for (let i = 0; i <= steps; i++) {
            const r = plazaR + ((R - plazaR) * i) / steps;
            const a = ((a0 + (rand() - 0.5) * 10 * (i / steps)) * Math.PI) / 180;
            const p = at(Math.cos(a) * r, Math.sin(a) * r);
            if (i > 0 && !dry(p)) break;
            pts.push(p);
        }
        if (pts.length >= 2) streets.push(pts);
    }
    if (prof.ring) {
        const rr = R * 0.55;
        const n = 18;
        let run: P[] = [];
        for (let i = 0; i <= n; i++) {
            const a = ((i / n) * 360 + baseAngle) * (Math.PI / 180);
            const p = at(Math.cos(a) * rr, Math.sin(a) * rr);
            if (dry(p)) run.push(p);
            else {
                if (run.length >= 2) streets.push(run);
                run = [];
            }
        }
        if (run.length >= 2) streets.push(run);
    }
    const streetWidth = spot.spotType === "capital" || spot.spotType === "city" ? 8 : spot.spotType === "village" || spot.spotType === "camp" ? 4.5 : 6;
    for (const pts of streets) out.push(make("street", pts[0][0], pts[0][1], { points: pts, widthM: streetWidth }));

    // Buildings along the streets, both sides, fronts to the street; landmarks first (nearest the middle).
    const queue: StructureKind[] = [...prof.landmarks];
    const houseCount = Math.round(prof.houses * scale);
    for (let i = 0; i < houseCount; i++) queue.push(prof.houseKinds[Math.floor(rand() * prof.houseKinds.length)]);
    const slots: Array<{ x: number; y: number; rot: number; d: number }> = [];
    const clip = (pts: P[]) => pts.filter((q) => Math.hypot(q[0] - cx, q[1] - cy) * 1000 <= R * 1.1);
    const slotLines: Array<{ pts: P[]; widthM: number }> = [
        ...streets.map((pts) => ({ pts, widthM: streetWidth })),
        ...roadLines.map((l) => ({ pts: densify(l.pts, 0.03), widthM: l.halfM * 2 })).map((l) => ({ ...l, pts: clip(l.pts) })).filter((l) => l.pts.length >= 2),
    ];
    for (const { pts, widthM } of slotLines) {
        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
            const segM = Math.hypot(bx - ax, by - ay) * 1000;
            const ang = Math.atan2(by - ay, bx - ax);
            const nx = -Math.sin(ang), ny = Math.cos(ang);
            for (let s = 8; s < segM - 4; s += 13 + rand() * 6) {
                const f = s / segM;
                const px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
                for (const side of [1, -1]) {
                    const off = (widthM / 2 + 7 + rand() * 3) * M * side;
                    const x = px + nx * off, y = py + ny * off;
                    // Front (local -y) toward the street: local -y rotated by rot must point at -side*n.
                    const rot = (ang * 180) / Math.PI + (side > 0 ? 0 : 180);
                    slots.push({ x, y, rot, d: Math.hypot(x - cx, y - cy) * 1000 });
                }
            }
        }
    }
    slots.sort((a, b) => a.d - b.d);
    let qi = 0;
    for (const sl of slots) {
        if (qi >= queue.length) break;
        if (sl.d > R * 1.05) continue;
        const kind = queue[qi];
        const info = STRUCTURE_KINDS[kind];
        const jitter = 0.85 + rand() * 0.3;
        const w = Math.round(info.widthM * jitter * 10) / 10;
        const d = Math.round(info.depthM * jitter * 10) / 10;
        const r = Math.max(w, d) / 2;
        // Push big buildings back so their front sits at the same setback as the houses.
        const a = (sl.rot * Math.PI) / 180;
        const back = Math.max(0, d / 2 - 4) * M;
        // The front (local -y) points along (sin a, -cos a); back is the opposite way.
        const x = sl.x - Math.sin(a) * back, y = sl.y + Math.cos(a) * back;
        if (!free(x, y, r) || onRoad(x, y, r)) continue;
        if (!buildable([x, y])) {
            skipped++;
            continue;
        }
        out.push(make(kind, x, y, { widthM: w, depthM: d, rotationDeg: sl.rot }));
        taken.push({ x, y, r });
        qi++;
    }

    // Walls with gatehouses where the spokes leave.
    if (prof.walls) {
        // Around what was built, not the whole reach of the streets.
        const builtR = Math.max(R * 0.4, ...out.filter((x) => isFootprint(x.shape)).map((x) => Math.hypot(x.x - cx, x.y - cy) * 1000 + Math.max(x.widthM, x.depthM) / 2));
        const wr = builtR + 25;
        const n = 28;
        let run: P[] = [];
        const flush = () => {
            if (run.length >= 2) out.push(make("wall", run[0][0], run[0][1], { points: run, widthM: spot.spotType === "capital" ? 6 : 4 }));
            run = [];
        };
        for (let i = 0; i <= n; i++) {
            const a = ((i / n) * 360 + baseAngle + 7) * (Math.PI / 180);
            const p = at(Math.cos(a) * wr, Math.sin(a) * wr);
            if (dry(p)) run.push(p);
            else flush();
        }
        flush();
        const exits: number[] = [];
        for (const pts of streets) {
            const last = pts[pts.length - 1];
            const dist = Math.hypot(last[0] - cx, last[1] - cy) * 1000;
            if (dist < Math.min(wr, R * 0.9)) continue; // a ring street, or a spoke that stopped short (at the water)
            exits.push(Math.atan2(last[1] - cy, last[0] - cx));
        }
        for (const d of roadDirs) exits.push((d * Math.PI) / 180);
        const used: number[] = [];
        for (const ang of exits) {
            if (used.some((u) => Math.abs(Math.atan2(Math.sin(ang - u), Math.cos(ang - u))) < 0.2)) continue;
            used.push(ang);
            const g: P = at(Math.cos(ang) * wr, Math.sin(ang) * wr);
            if (!dry(g)) continue;
            out.push(make("gate", g[0], g[1], { rotationDeg: (ang * 180) / Math.PI - 90 }));
        }
    }

    // Docks: on the shore nearest the middle, reaching out over the water.
    if (spot.spotType === "port" || spot.spotType === "capital" || spot.spotType === "city") {
        let shore: { p: P; a: number } | null = null;
        for (let r = 30; r <= R * 1.6 && !shore; r += 15) {
            for (let k = 0; k < 36; k++) {
                const a = (k / 36) * Math.PI * 2;
                const p = at(Math.cos(a) * r, Math.sin(a) * r);
                if (!dry(p)) {
                    shore = { p: at(Math.cos(a) * (r - 12), Math.sin(a) * (r - 12)), a };
                    break;
                }
            }
        }
        if (shore) {
            const docks = spot.spotType === "port" ? 4 : 2;
            for (let i = 0; i < docks; i++) {
                const side = (i - (docks - 1) / 2) * 22;
                const tx = -Math.sin(shore.a), ty = Math.cos(shore.a);
                const x = shore.p[0] + tx * side * M + Math.cos(shore.a) * 18 * M;
                const y = shore.p[1] + ty * side * M + Math.sin(shore.a) * 18 * M;
                // Local +y (the pier's length) points out to sea.
                out.push(make("dock", x, y, { rotationDeg: (shore.a * 180) / Math.PI - 90 }));
            }
        }
    }

    // Fields around the edge (villages, shrines).
    for (let i = 0; i < prof.fields; i++) {
        const a = ((baseAngle + 45 + (360 / Math.max(1, prof.fields)) * i + (rand() - 0.5) * 30) * Math.PI) / 180;
        const r = R + 90 + rand() * 60;
        const [fx, fy] = at(Math.cos(a) * r, Math.sin(a) * r);
        const w = 110 + rand() * 80, d = 70 + rand() * 50;
        const rot = (a * 180) / Math.PI + 90;
        const corners = localOutline("rect", w, d).map((p) => toWorld({ x: fx, y: fy, rotationDeg: rot }, p));
        if (!corners.every(buildable)) {
            skipped++;
            continue;
        }
        out.push(make("field", fx, fy, { points: corners, widthM: w, depthM: d, rotationDeg: rot }));
    }

    // Areas first, then streets and walls, then buildings: the order the map draws them in.
    const rank = (s: WorldStructure) => (s.shape === "area" ? 0 : s.shape === "street" ? 1 : s.shape === "wall" ? 2 : 3);
    out.sort((a, b) => rank(a) - rank(b));
    return { structures: out, skipped };
}

/** Draw order for the map: areas, streets, walls, then footprints (smaller on top). */
export function drawOrder(list: WorldStructure[]): WorldStructure[] {
    const rank = (s: WorldStructure) => (s.shape === "area" ? 0 : s.shape === "street" ? 1 : s.shape === "wall" ? 2 : 3);
    return [...list].sort((a, b) => rank(a) - rank(b) || b.widthM * b.depthM - a.widthM * a.depthM);
}
