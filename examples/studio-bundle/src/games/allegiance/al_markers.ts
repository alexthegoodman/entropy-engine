// Sky markers and the mini map. Towns and cities near you get a marker high in the sky over them
// (so you can see where to fly), along with military compounds, the party's headquarters and
// the current mission target. Markers are projected to the screen and pinned to its edge when
// they are behind you or off to the side. The mini map is a north-up plan of the street map
// around you (buildings and water from the nav grid) with the same places as dots.

import { type Vec3, cross, dot, normalize, sub } from "../../apps/quadplanet/qp_math";
import { PARTY, factionById, type RGBA } from "./al_data";
import { type Campaign, EARTH_RADIUS_KM, angularDistance, campaignRegions } from "./al_state";

// --- Projection ----------------------------------------------------------------------------------

/** The render camera as the HUD needs it: where it is, its axes, and the tangents of half its field of view. */
export interface CameraBasis { position: Vec3; forward: Vec3; right: Vec3; up: Vec3; tanX: number; tanY: number }

export function cameraBasis(position: Vec3, target: Vec3, upHint: Vec3, tanX = 0.414 * 16 / 9, tanY = 0.414): CameraBasis {
    const forward = normalize(sub(target, position));
    const right = normalize(cross(forward, upHint));
    const up = cross(right, forward);
    return { position, forward, right, up, tanX, tanY };
}

/**
 * Field-of-view tangents from the engine's own picking rays (Camera.screenToWorldRay) at the right
 * edge and the top edge of the screen, so projection matches whatever projection is active.
 */
export function calibrate(b: CameraBasis, rightEdgeRay: Vec3, topEdgeRay: Vec3): { tanX: number; tanY: number } {
    const fx = dot(rightEdgeRay, b.forward), fy = dot(topEdgeRay, b.forward);
    const tanX = fx > 1e-3 ? dot(rightEdgeRay, b.right) / fx : b.tanX;
    const tanY = fy > 1e-3 ? dot(topEdgeRay, b.up) / fy : b.tanY;
    return { tanX: Math.abs(tanX) > 0.05 ? tanX : b.tanX, tanY: Math.abs(tanY) > 0.05 ? tanY : b.tanY };
}

export interface Projected { x: number; y: number; onScreen: boolean; behind: boolean; distance: number }

/**
 * A world point on a W x H screen. Points off screen (or behind the camera) are pinned to the
 * screen's edge, `margin` pixels in, in the direction they lie.
 */
export function project(b: CameraBasis, p: Vec3, W: number, H: number, margin = 36): Projected {
    const d = sub(p, b.position);
    const z = dot(d, b.forward), x = dot(d, b.right), y = dot(d, b.up);
    const distance = Math.hypot(d[0], d[1], d[2]);
    const behind = z <= 1e-3;
    let nx: number, ny: number;
    if (!behind) { nx = x / z / b.tanX; ny = y / z / b.tanY; }
    else { const l = Math.hypot(x, y) || 1; nx = x / l * 4; ny = y / l * 4; if (Math.abs(nx) < 1e-6 && Math.abs(ny) < 1e-6) ny = -4; }
    let sx = W / 2 * (1 + nx), sy = H / 2 * (1 - ny);
    const onScreen = !behind && sx >= margin && sx <= W - margin && sy >= margin && sy <= H - margin;
    if (!onScreen) {
        // Pin to the edge along the ray from the screen's center.
        const cx = W / 2, cy = H / 2, dx = sx - cx, dy = sy - cy;
        const k = Math.min(Math.abs((W / 2 - margin) / (dx || 1e-9)), Math.abs((H / 2 - margin) / (dy || 1e-9)));
        sx = cx + dx * Math.min(1, k); sy = cy + dy * Math.min(1, k);
        if (behind) { sx = cx + dx * k; sy = cy + dy * k; }
    }
    return { x: sx, y: sy, onScreen, behind, distance };
}

// --- Markers -------------------------------------------------------------------------------------

export type MarkerKind = "city" | "town" | "compound" | "hq" | "mission";

export interface SkyMarker {
    id: string;
    kind: MarkerKind;
    label: string;
    lat: number;
    lon: number;
    km: number;
    color: RGBA;
    /** Meters above the ground the marker floats. */
    lift: number;
}

const HQ_COLOR = (c: Campaign): RGBA => c.party.color;
const ENEMY: RGBA = [0.9, 0.18, 0.15, 1];
const GOLD: RGBA = [0.96, 0.78, 0.25, 1];

/**
 * The places worth a marker from (lat, lon): towns and cities within `rangeKm` (nearest first,
 * at most `max`), uncaptured compounds within `compoundKm`, your headquarters and the mission's
 * target wherever they are.
 */
export function skyMarkers(c: Campaign, lat: number, lon: number, opts: { rangeKm?: number; max?: number; compoundKm?: number; missionCompound?: string | null } = {}): SkyMarker[] {
    const range = opts.rangeKm ?? 60, max = opts.max ?? 10, compoundKm = opts.compoundKm ?? 6;
    const out: SkyMarker[] = [];
    const places = campaignRegions(c)
        .filter(d => !d.parent || d.kind === "city" || d.kind === "town")
        .map(d => ({ d, km: angularDistance(lat, lon, d.lat, d.lon) * EARTH_RADIUS_KM }))
        .filter(x => x.km <= range && x.km > 0.4)
        .sort((a, b) => a.km - b.km).slice(0, max);
    for (const { d, km } of places) {
        const gov = c.regions[d.id]?.governor ?? "concordat";
        out.push({ id: d.id, kind: d.parent && d.kind === "town" ? "town" : "city", label: d.name.toUpperCase(), lat: d.lat, lon: d.lon, km,
            color: gov === PARTY ? c.party.color : factionById(gov).color, lift: d.parent ? 220 : 400 });
    }
    for (const cs of Object.values(c.compounds ?? {})) {
        const km = angularDistance(lat, lon, cs.lat, cs.lon) * EARTH_RADIUS_KM;
        const isMission = cs.id === opts.missionCompound;
        if (cs.captured || (km > compoundKm && !isMission)) continue;
        out.push({ id: cs.id, kind: isMission ? "mission" : "compound", label: isMission ? "OBJECTIVE: OUTPOST" : "MILITARY COMPOUND", lat: cs.lat, lon: cs.lon, km,
            color: isMission ? GOLD : ENEMY, lift: 60 });
    }
    const hq = c.party.hqSite;
    if (hq) out.push({ id: "party-hq", kind: "hq", label: `${c.party.name.toUpperCase()} HQ`, lat: hq.lat, lon: hq.lon,
        km: angularDistance(lat, lon, hq.lat, hq.lon) * EARTH_RADIUS_KM, color: HQ_COLOR(c), lift: 120 });
    return out;
}

export const distanceLabel = (km: number): string => km >= 10 ? `${Math.round(km)} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`;

/** A marker placed on the screen, ready for the HUD. */
export interface ScreenMarker { id: string; kind: MarkerKind; label: string; distance: string; x: number; y: number; color: RGBA; onScreen: boolean }

// --- Mini map ------------------------------------------------------------------------------------

/** Runs of blocked cells per row: [row, firstColumn, lastColumn, what (1 building, 2 water)]. */
export type MapRun = [number, number, number, number];

export interface MiniMap {
    /** Cells per side, and meters per cell. */
    cells: number;
    cellMeters: number;
    runs: MapRun[];
    /** Places on the map, in cell units from the top-left (north up). */
    dots: { x: number; y: number; color: RGBA; size: number; kind: string }[];
    /** Your heading (radians clockwise from north). */
    heading: number;
}

/**
 * A north-up map of `cells` x `cells` around (cx, cz), sampling `what` (0 open, 1 building, 2
 * water) at each cell's center, merged into horizontal runs so it draws as few rectangles.
 */
export function miniMapRuns(what: (x: number, z: number) => number, cx: number, cz: number, cells: number, cellMeters: number): MapRun[] {
    const runs: MapRun[] = [];
    const half = cells / 2;
    for (let j = 0; j < cells; j++) {
        const z = cz + (half - j - 0.5) * cellMeters;
        let start = -1, kind = 0;
        for (let i = 0; i <= cells; i++) {
            const k = i < cells ? what(cx + (i - half + 0.5) * cellMeters, z) : 0;
            if (k !== kind) {
                if (kind) runs.push([j, start, i - 1, kind]);
                start = i; kind = k;
            }
        }
    }
    return runs;
}

/** A local point -> mini-map cell coordinates (x right/east, y down/south), or null off the map. */
export function toMapCell(m: Pick<MiniMap, "cells" | "cellMeters">, cx: number, cz: number, x: number, z: number, clampEdge = false): { x: number; y: number } | null {
    let mx = m.cells / 2 + (x - cx) / m.cellMeters, my = m.cells / 2 - (z - cz) / m.cellMeters;
    const inside = mx >= 0 && my >= 0 && mx <= m.cells && my <= m.cells;
    if (!inside && !clampEdge) return null;
    mx = Math.max(0, Math.min(m.cells, mx)); my = Math.max(0, Math.min(m.cells, my));
    return { x: mx, y: my };
}
