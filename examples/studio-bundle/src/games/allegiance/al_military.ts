// Military compounds: every town and city keeps a walled cluster of military buildings - the
// target for taking it by force. Civilians are never the target (al_street.ts: bullets pass
// through them); the garrison is. Clear the defenders, raise your flag in the courtyard, and the
// settlement is yours. The founding outpost near your hometown becomes the party's headquarters.
//
// Compounds are plain data in the campaign (CompoundState): where they stand, how many buildings
// (proportional to the population they hold) and how many defenders are left. Layouts are
// deterministic in the compound's id, so the same buildings stand there every visit.

import { type RegionDef, regionDefById } from "./al_data";
import { type Campaign, type CompoundState, EARTH_RADIUS_KM, angularDistance } from "./al_state";
import { hashString } from "./al_rng";

/** People a settlement holds (RegionDef.pop is in millions). */
const people = (def: RegionDef) => def.pop * 1e6;

/** Buildings in a settlement's compound: one for a dwelling, 4 for a village, 7 for a city, 10 for a capital territory. */
export function compoundBuildings(def: RegionDef): number {
    return Math.max(1, Math.min(10, Math.round(1 + 1.6 * Math.log10(Math.max(25, people(def)) / 25))));
}

/** Defenders: two per building (the live street simulation spawns them a few at a time). */
export function compoundGarrison(buildings: number): number {
    return Math.max(2, Math.min(20, buildings * 2));
}

/** A point `km` away from (lat, lon) on bearing `bearing` (radians, clockwise from north). */
export function offsetLatLon(lat: number, lon: number, km: number, bearing: number): { lat: number; lon: number } {
    const d = km / EARTH_RADIUS_KM, r = Math.PI / 180;
    const la = lat * r, lo = lon * r;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(bearing));
    const lo2 = lo + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return { lat: la2 / r, lon: ((lo2 / r + 540) % 360) - 180 };
}

/** The garrison compound of a settlement (or territory capital), on its outskirts. */
export function compoundPlan(def: RegionDef): CompoundState {
    const h = hashString(`compound:${def.id}`);
    const bearing = (h % 3600) / 3600 * Math.PI * 2;
    const kind = def.kind ?? "city";
    const km = def.parent ? ({ city: 1.1, town: 0.6, village: 0.35, hamlet: 0.25 } as Record<string, number>)[kind] ?? 0.2 : 1.6;
    const at = offsetLatLon(def.lat, def.lon, km, bearing);
    const buildings = compoundBuildings(def);
    const garrison = compoundGarrison(buildings);
    return { id: `mil-${def.id}`, settlement: def.id, kind: "garrison", lat: at.lat, lon: at.lon, yaw: ((h >>> 12) % 360) * Math.PI / 180,
        buildings, garrison, maxGarrison: garrison, captured: false, sited: false };
}

/** The small outpost near where you start: the founding mission's target and your future headquarters. */
export function outpostPlan(settlement: string, lat: number, lon: number): CompoundState {
    const h = hashString(`outpost:${settlement}`);
    const at = offsetLatLon(lat, lon, 0.28, (h % 3600) / 3600 * Math.PI * 2);
    return { id: `outpost-${settlement}`, settlement, kind: "outpost", lat: at.lat, lon: at.lon, yaw: ((h >>> 12) % 360) * Math.PI / 180,
        buildings: 2, garrison: 5, maxGarrison: 5, captured: false, sited: false };
}

/** The compound of a settlement, created the first time it is wanted. */
export function ensureCompound(c: Campaign, settlement: string): CompoundState | null {
    const def = regionDefById(settlement);
    if (!def) return null;
    const id = `mil-${settlement}`;
    const all = (c.compounds ??= {});
    return all[id] ??= compoundPlan(def);
}

/** Compounds within `km` of a point (nearest first): those of nearby settlements, made as needed, and any outposts. */
export function compoundsNear(c: Campaign, lat: number, lon: number, km: number, settlements: RegionDef[]): CompoundState[] {
    for (const d of settlements) {
        if (angularDistance(lat, lon, d.lat, d.lon) * EARTH_RADIUS_KM < km + 2) ensureCompound(c, d.id);
    }
    return Object.values(c.compounds ?? {})
        .map(cs => ({ cs, d: angularDistance(lat, lon, cs.lat, cs.lon) * EARTH_RADIUS_KM }))
        .filter(x => x.d <= km).sort((a, b) => a.d - b.d).map(x => x.cs);
}

// --- Layout --------------------------------------------------------------------------------------

export type StructureKind = "hq" | "barracks" | "depot" | "tower" | "wall" | "hangar";

/** One structure in compound space: x right, z forward (toward the gate), meters from the courtyard. */
export interface Structure { kind: StructureKind; x: number; z: number; w: number; d: number; h: number; yaw: number }

export interface CompoundLayout {
    structures: Structure[];
    /** The flagpole in the courtyard (compound space). */
    flag: [number, number];
    /** Radius of the walled area. */
    radius: number;
    /** Where defenders stand guard (compound space). */
    posts: [number, number][];
}

const SIZES: Record<Exclude<StructureKind, "wall" | "tower">, [number, number, number]> = {
    hq: [14, 10, 7], barracks: [18, 7, 4.5], depot: [11, 11, 5.5], hangar: [16, 14, 6.5],
};

/** The buildings, walls, towers and guard posts of a compound (deterministic in its id). */
export function compoundLayout(cs: Pick<CompoundState, "id" | "buildings" | "kind">): CompoundLayout {
    const n = Math.max(1, cs.buildings);
    const radius = cs.kind === "outpost" ? 22 : 20 + n * 4;
    const out: Structure[] = [];
    let h = hashString(`layout:${cs.id}`);
    const next = () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = (h ^ (h >>> 12)) >>> 0; return h / 4294967296; };
    // Buildings ring the courtyard, facing in; the gate side (+z) stays open.
    const kinds: Exclude<StructureKind, "wall" | "tower">[] = ["hq", "barracks", "depot", "barracks", "hangar", "barracks", "depot", "barracks", "hangar", "depot"];
    const ring = radius - 9;
    for (let i = 0; i < n; i++) {
        const span = Math.PI * 1.5;
        const a = Math.PI + (n === 1 ? 0 : (i / (n - 1) - 0.5) * span) + (next() - 0.5) * 0.08;
        const [w, d, ht] = SIZES[kinds[i % kinds.length]];
        const scale = cs.kind === "outpost" ? 0.7 : 1;
        out.push({ kind: kinds[i % kinds.length], x: Math.sin(a) * ring, z: Math.cos(a) * ring, w: w * scale, d: d * scale, h: ht, yaw: a + Math.PI });
    }
    // The perimeter wall in segments, with a gate gap at the front.
    const segments = 16;
    for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
        const mid = (a0 + a1) / 2;
        if (Math.abs(Math.atan2(Math.sin(mid), Math.cos(mid))) < 0.25) continue;
        const len = 2 * radius * Math.sin(Math.PI / segments);
        out.push({ kind: "wall", x: Math.sin(mid) * radius, z: Math.cos(mid) * radius, w: len + 0.4, d: 0.6, h: 2.6, yaw: mid });
    }
    // Watchtowers at four corners.
    for (const a of [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4])
        out.push({ kind: "tower", x: Math.sin(a) * radius, z: Math.cos(a) * radius, w: 3, d: 3, h: 9, yaw: a });
    const posts: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + next() * 0.3;
        const rr = i % 2 ? radius * 0.35 : radius * 0.62;
        posts.push([Math.sin(a) * rr, Math.cos(a) * rr]);
    }
    return { structures: out, flag: [0, 2], radius, posts };
}

/** Compound space -> the street's local frame, with the compound centered at (cx, cz) and turned by `yaw`. */
export function compoundToLocal(cx: number, cz: number, yaw: number, x: number, z: number): [number, number] {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return [cx + x * c + z * s, cz - x * s + z * c];
}

/**
 * A clear spot for a compound of `radius` near (x, z): every sampled cell walkable (no
 * buildings, no water), searched in rings out to `search` meters. Null if the map has no room.
 */
export function findClearSite(walkable: (x: number, z: number) => boolean, x: number, z: number, radius: number, search = 260, step = 12): [number, number] | null {
    const clear = (cx: number, cz: number) => {
        for (let dz = -radius; dz <= radius; dz += 4) for (let dx = -radius; dx <= radius; dx += 4) {
            if (dx * dx + dz * dz > radius * radius) continue;
            if (!walkable(cx + dx, cz + dz)) return false;
        }
        return true;
    };
    for (let ring = 0; ring * step <= search; ring++) {
        const count = ring ? Math.ceil(2 * Math.PI * ring) : 1;
        for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2;
            const px = x + Math.sin(a) * ring * step, pz = z + Math.cos(a) * ring * step;
            if (clear(px, pz)) return [px, pz];
        }
    }
    return null;
}

// --- Capture -------------------------------------------------------------------------------------

/** Seconds standing at the flag (with no defenders left) to raise your colors. */
export const RAISE_SECONDS = 6;
/** Meters from the flagpole that count as "at the flag". */
export const FLAG_REACH = 6;
/** Defenders on the street at once (the rest come out as these fall). */
export const GUARDS_AT_ONCE = 8;

export type CaptureState = "held" | "contested" | "raising" | "captured";

/**
 * Advances the capture of `cs`: contested while any defender is left, then raising while you stand
 * at the flag (the progress resets if you step away), captured once raised.
 */
export function stepCapture(cs: CompoundState, progress: { raise: number }, atFlag: boolean, dt: number): CaptureState {
    if (cs.captured) return "captured";
    if (cs.garrison > 0) { progress.raise = 0; return "contested"; }
    if (!atFlag) { progress.raise = 0; return "held"; }
    progress.raise += dt;
    if (progress.raise >= RAISE_SECONDS) { cs.captured = true; return "captured"; }
    return "raising";
}

/** A defender fell: one fewer left in the compound. */
export function defenderDown(cs: CompoundState): void {
    cs.garrison = Math.max(0, cs.garrison - 1);
}

/** A held compound slowly reinforces (daily): the regime refills its garrison while you are away
 * (not while you are within `nearKm` of it, mid-assault). */
export function reinforceCompounds(c: Campaign, nearKm = 2): void {
    for (const cs of Object.values(c.compounds ?? {})) {
        if (cs.captured) continue;
        if (angularDistance(c.player.lat, c.player.lon, cs.lat, cs.lon) * EARTH_RADIUS_KM < nearKm) continue;
        if (cs.garrison < cs.maxGarrison) cs.garrison = Math.min(cs.maxGarrison, cs.garrison + Math.max(1, Math.round(cs.maxGarrison * 0.25)));
    }
}
