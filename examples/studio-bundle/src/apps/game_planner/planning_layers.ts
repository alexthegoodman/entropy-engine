// Planning marks and codex placements: what the designer paints and pins on the map to plan a
// region's biome and population, without building any of it.
//
// - Marks are densities painted on a coarse world grid (`PlanningOverlay`): forest, meadow,
//   farmland, rock, snow... The map draws them as symbols (trees, tufts, hatching), never as real
//   foliage. A mark can also be a codex entry ("codex:<id>"): where an enemy roams, where a
//   faction holds sway, where villagers are found.
// - Placements pin one codex entry at one place: a named NPC, a bandit camp of 6, a patrol.
// - Regions read both: what is painted inside them, who is placed there, what biome the paint
//   suggests; codex entries read where they appear on the map.

import type {
    BiomeType,
    CodexCategory,
    CodexEntry,
    CodexPlacement,
    GameWorld,
    MarkGlyph,
    PlacementBehavior,
    PlanningOverlay,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import { brushFalloff, pointInPolygon } from "./terrain_sculpt";

type RGBA = [number, number, number, number];
type Pt = [number, number];

export interface MarkDef {
    id: string;
    label: string;
    color: RGBA;
    glyph: MarkGlyph;
    /** The biome this mark suggests for a region dominated by it. */
    biome?: BiomeType;
    hint: string;
}

/** The surface marks a designer can paint. Order is the palette's order. */
export const MARKS: MarkDef[] = [
    { id: "forest", label: "Forest", color: [0.16, 0.62, 0.3, 0.9], glyph: "tree", biome: "forest", hint: "woodland, trees" },
    { id: "jungle", label: "Jungle", color: [0.1, 0.72, 0.45, 0.9], glyph: "tree", biome: "jungle", hint: "dense tropical growth" },
    { id: "conifer", label: "Pine / taiga", color: [0.2, 0.48, 0.42, 0.9], glyph: "tree", biome: "taiga", hint: "evergreen forest" },
    { id: "meadow", label: "Meadow / grass", color: [0.55, 0.8, 0.3, 0.85], glyph: "grass", biome: "plains", hint: "open grassland" },
    { id: "farmland", label: "Farmland", color: [0.86, 0.72, 0.3, 0.85], glyph: "hatch", biome: "plains", hint: "fields, orchards, pasture" },
    { id: "brush", label: "Scrub / brush", color: [0.6, 0.6, 0.3, 0.85], glyph: "dot", biome: "savanna", hint: "low shrubs, dry brush" },
    { id: "marsh", label: "Marsh / bog", color: [0.32, 0.55, 0.45, 0.9], glyph: "wave", biome: "swamp", hint: "wetland, reeds" },
    { id: "sand", label: "Sand / dunes", color: [0.92, 0.8, 0.5, 0.85], glyph: "dot", biome: "desert", hint: "beach, desert" },
    { id: "rock", label: "Rock / scree", color: [0.62, 0.6, 0.58, 0.85], glyph: "rock", biome: "badlands", hint: "cliffs, boulders, bare stone" },
    { id: "snow", label: "Snow / ice", color: [0.88, 0.94, 1.0, 0.9], glyph: "snow", biome: "alpine", hint: "snowfields, glaciers" },
    { id: "ash", label: "Ash / lava", color: [0.85, 0.3, 0.18, 0.9], glyph: "cross", biome: "volcanic", hint: "volcanic waste" },
    { id: "blight", label: "Blight / corruption", color: [0.62, 0.3, 0.85, 0.9], glyph: "cross", hint: "cursed, poisoned or alien ground" },
    { id: "ruins", label: "Ruins / debris", color: [0.7, 0.66, 0.6, 0.85], glyph: "diamond", hint: "rubble, old foundations" },
    { id: "urban", label: "Built-up", color: [0.75, 0.78, 0.85, 0.85], glyph: "square", hint: "streets, blocks, sprawl" },
];

export const MARK_BY_ID: Record<string, MarkDef> = Object.fromEntries(MARKS.map((m) => [m.id, m]));

export const PLACEMENT_BEHAVIORS: PlacementBehavior[] = ["static", "wander", "patrol", "guard", "ambush", "spawner", "vendor", "quest_giver"];

/** How a codex entry looks on the map, by category. */
export const CODEX_MAP_STYLE: Record<CodexCategory, { color: RGBA; glyph: MarkGlyph; noun: string }> = {
    character: { color: [0.25, 0.78, 0.98, 0.95], glyph: "person", noun: "NPC" },
    creature: { color: [0.96, 0.3, 0.38, 0.95], glyph: "skull", noun: "enemy" },
    faction: { color: [0.98, 0.72, 0.2, 0.95], glyph: "flag", noun: "faction" },
    weapon: { color: [0.85, 0.85, 0.9, 0.95], glyph: "diamond", noun: "item" },
    power: { color: [0.7, 0.5, 0.98, 0.95], glyph: "diamond", noun: "power" },
    lore: { color: [0.8, 0.7, 0.55, 0.95], glyph: "diamond", noun: "lore site" },
};

/** Codex categories that make sense to paint or place on the map. */
export const PLACEABLE_CATEGORIES: CodexCategory[] = ["creature", "character", "faction", "lore", "weapon", "power"];

export const codexLayerKey = (codexId: string) => `codex:${codexId}`;
export const isCodexLayer = (key: string) => key.startsWith("codex:");
export const codexIdOfLayer = (key: string) => key.slice(6);

// -------------------------------------------------------------------------------------------------
// The overlay grid
// -------------------------------------------------------------------------------------------------

/** About 250 m cells on a 25 km world; never coarser than 48 or finer than 128 per side. */
export function overlaySizeFor(widthKm: number, heightKm: number): { cols: number; rows: number } {
    const cell = Math.max(0.15, Math.max(widthKm, heightKm) / 110);
    return {
        cols: Math.max(48, Math.min(128, Math.round(widthKm / cell))),
        rows: Math.max(48, Math.min(128, Math.round(heightKm / cell))),
    };
}

export function emptyOverlay(widthKm: number, heightKm: number): PlanningOverlay {
    return { ...overlaySizeFor(widthKm, heightKm), layers: {} };
}

type Meta = { worldWidthKm: number; worldHeightKm: number };

export function cellCenter(o: PlanningOverlay, meta: Meta, c: number, r: number): Pt {
    return [-meta.worldWidthKm / 2 + ((c + 0.5) * meta.worldWidthKm) / o.cols, meta.worldHeightKm / 2 - ((r + 0.5) * meta.worldHeightKm) / o.rows];
}

export function cellAt(o: PlanningOverlay, meta: Meta, x: number, y: number): [number, number] | null {
    const c = Math.floor(((x + meta.worldWidthKm / 2) / meta.worldWidthKm) * o.cols);
    const r = Math.floor(((meta.worldHeightKm / 2 - y) / meta.worldHeightKm) * o.rows);
    if (c < 0 || r < 0 || c >= o.cols || r >= o.rows) return null;
    return [c, r];
}

export function cellAreaKm2(o: PlanningOverlay, meta: Meta): number {
    return (meta.worldWidthKm / o.cols) * (meta.worldHeightKm / o.rows);
}

/** Painted density of a layer at a world position (0 when unpainted). */
export function markAt(o: PlanningOverlay | undefined, meta: Meta, key: string, x: number, y: number): number {
    const layer = o?.layers[key];
    if (!o || !layer) return 0;
    const cell = cellAt(o, meta, x, y);
    return cell ? layer[cell[1] * o.cols + cell[0]] || 0 : 0;
}

/** Every painted layer at a world position, densest first. */
export function marksAt(o: PlanningOverlay | undefined, meta: Meta, x: number, y: number): Array<{ key: string; density: number }> {
    if (!o) return [];
    const cell = cellAt(o, meta, x, y);
    if (!cell) return [];
    const k = cell[1] * o.cols + cell[0];
    return Object.entries(o.layers)
        .map(([key, data]) => ({ key, density: data[k] || 0 }))
        .filter((m) => m.density > 0.02)
        .sort((a, b) => b.density - a.density);
}

export interface PaintOptions {
    radiusKm: number;
    /** 0..1: how much one dab adds. */
    strength: number;
    erase?: boolean;
    /** Only paint inside this polygon (a region's outline). */
    clip?: Pt[];
    /** Painting a mark thins out the other surface marks under it (forest over meadow), so a cell reads as one thing. */
    exclusive?: boolean;
}

/**
 * Paints a layer along a stroke, in place. Densities stay in 0..1 (rounded to 0.01 for compact
 * saves). Returns how many cells changed.
 */
export function paintStroke(o: PlanningOverlay, meta: Meta, key: string, points: Pt[], opts: PaintOptions): number {
    if (!points.length) return 0;
    const n = o.cols * o.rows;
    const layer = (o.layers[key] ??= new Array(n).fill(0));
    const others = opts.exclusive && !isCodexLayer(key) ? Object.keys(o.layers).filter((k) => k !== key && !isCodexLayer(k)) : [];
    const cw = meta.worldWidthKm / o.cols;
    const ch = meta.worldHeightKm / o.rows;
    const r = Math.max(cw * 0.6, opts.radiusKm);
    // Dabs every third of the radius along the stroke.
    const dabs: Pt[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        const d = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(d / (r * 0.33)));
        for (let k = 1; k <= steps; k++) dabs.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
    }
    // The strongest touch per cell across the stroke, so a slow drag does not over-paint.
    const touch = new Map<number, number>();
    for (const [x, y] of dabs) {
        const c0 = Math.max(0, Math.floor((x - r + meta.worldWidthKm / 2) / cw));
        const c1 = Math.min(o.cols - 1, Math.floor((x + r + meta.worldWidthKm / 2) / cw));
        const r0 = Math.max(0, Math.floor((meta.worldHeightKm / 2 - (y + r)) / ch));
        const r1 = Math.min(o.rows - 1, Math.floor((meta.worldHeightKm / 2 - (y - r)) / ch));
        for (let row = r0; row <= r1; row++) {
            for (let col = c0; col <= c1; col++) {
                const [wx, wy] = cellCenter(o, meta, col, row);
                const w = brushFalloff(Math.hypot(wx - x, wy - y), r);
                if (w <= 0) continue;
                if (opts.clip && !pointInPolygon(wx, wy, opts.clip)) continue;
                const k = row * o.cols + col;
                touch.set(k, Math.max(touch.get(k) || 0, w));
            }
        }
    }
    const s = Math.min(1, Math.max(0.02, opts.strength));
    let changed = 0;
    for (const [k, w] of touch) {
        const before = layer[k] || 0;
        const after = opts.erase ? Math.max(0, before - s * w * 1.5) : Math.min(1, before + s * Math.min(1, w * 1.6));
        const rounded = Math.round(after * 100) / 100;
        if (rounded !== before) {
            layer[k] = rounded;
            changed++;
        }
        if (!opts.erase && others.length && rounded > 0) {
            for (const ok of others) {
                const ol = o.layers[ok];
                if (ol[k]) ol[k] = Math.round(Math.max(0, ol[k] - s * w) * 100) / 100;
            }
        }
    }
    pruneOverlay(o);
    return changed;
}

/** Fills (or clears) a layer inside a polygon. */
export function fillPolygon(o: PlanningOverlay, meta: Meta, key: string, poly: Pt[], density: number): number {
    if (poly.length < 3) return 0;
    const n = o.cols * o.rows;
    const layer = (o.layers[key] ??= new Array(n).fill(0));
    let changed = 0;
    for (let row = 0; row < o.rows; row++) {
        for (let col = 0; col < o.cols; col++) {
            const [wx, wy] = cellCenter(o, meta, col, row);
            if (!pointInPolygon(wx, wy, poly)) continue;
            const k = row * o.cols + col;
            if (layer[k] !== density) {
                layer[k] = density;
                changed++;
            }
        }
    }
    pruneOverlay(o);
    return changed;
}

/** Clears every layer (or just one) inside a polygon. */
export function clearInside(o: PlanningOverlay, meta: Meta, poly: Pt[], key?: string): number {
    let changed = 0;
    for (const k of key ? [key] : Object.keys(o.layers)) changed += fillPolygon(o, meta, k, poly, 0);
    return changed;
}

/** Drops layers with nothing painted on them. */
export function pruneOverlay(o: PlanningOverlay): void {
    for (const [k, data] of Object.entries(o.layers)) {
        if (!data.some((v) => v > 0)) delete o.layers[k];
    }
}

/** Painted area (km², density-weighted) of each layer inside a polygon, or the whole world. */
export function layerCoverage(o: PlanningOverlay | undefined, meta: Meta, poly?: Pt[]): Array<{ key: string; areaKm2: number; share: number }> {
    if (!o) return [];
    const cellKm2 = cellAreaKm2(o, meta);
    let cells = 0;
    const inside: number[] = [];
    for (let row = 0; row < o.rows; row++) {
        for (let col = 0; col < o.cols; col++) {
            if (poly) {
                const [wx, wy] = cellCenter(o, meta, col, row);
                if (!pointInPolygon(wx, wy, poly)) continue;
            }
            inside.push(row * o.cols + col);
            cells++;
        }
    }
    if (!cells) return [];
    return Object.entries(o.layers)
        .map(([key, data]) => {
            let sum = 0;
            for (const k of inside) sum += data[k] || 0;
            return { key, areaKm2: Math.round(sum * cellKm2 * 100) / 100, share: sum / cells };
        })
        .filter((c) => c.areaKm2 > 0)
        .sort((a, b) => b.areaKm2 - a.areaKm2);
}

/** The biome a region's painted surface marks suggest, if any mark covers a fair share of it. */
export function suggestBiome(o: PlanningOverlay | undefined, meta: Meta, poly: Pt[]): { biome: BiomeType; mark: MarkDef; share: number } | null {
    const surfaces = layerCoverage(o, meta, poly).filter((c) => !isCodexLayer(c.key) && MARK_BY_ID[c.key]?.biome);
    const best = surfaces[0];
    if (!best || best.share < 0.15) return null;
    const mark = MARK_BY_ID[best.key];
    return { biome: mark.biome!, mark, share: best.share };
}

// -------------------------------------------------------------------------------------------------
// Placements
// -------------------------------------------------------------------------------------------------

export function createPlacement(codex: CodexEntry, x: number, y: number, opts: Partial<CodexPlacement> = {}): CodexPlacement {
    const enemy = codex.category === "creature";
    return {
        id: `place_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        codexId: codex.id,
        x: Number(x.toFixed(4)),
        y: Number(y.toFixed(4)),
        count: enemy ? 4 : 1,
        behavior: enemy ? "wander" : codex.category === "faction" ? "guard" : "static",
        notes: "",
        ...opts,
    };
}

export function placementsOf(world: GameWorld, codexId: string): CodexPlacement[] {
    return (world.placements ?? []).filter((p) => p.codexId === codexId);
}

export function placementsNear(world: GameWorld, x: number, y: number, radiusKm: number): CodexPlacement[] {
    return (world.placements ?? []).filter((p) => Math.hypot(p.x - x, p.y - y) <= radiusKm);
}

export function placementsInside(world: GameWorld, poly: Pt[]): CodexPlacement[] {
    return (world.placements ?? []).filter((p) => pointInPolygon(p.x, p.y, poly));
}

export function nearestSpot(world: GameWorld, x: number, y: number, maxKm = Infinity): WorldSpot | undefined {
    let best: WorldSpot | undefined;
    let bd = maxKm;
    for (const s of world.spots) {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d <= bd) {
            bd = d;
            best = s;
        }
    }
    return best;
}

export function regionsAt(world: GameWorld, x: number, y: number): WorldRegion[] {
    return world.regions.filter((r) => r.points.length >= 3 && pointInPolygon(x, y, r.points));
}

/** Highest danger at a place: the regions over it and nearby dangerous spots. */
export function dangerAt(world: GameWorld, x: number, y: number): number {
    let d = 0;
    for (const r of regionsAt(world, x, y)) d = Math.max(d, r.dangerLevel || 0);
    for (const s of world.spots) {
        if (s.dangerLevel && Math.hypot(s.x - x, s.y - y) < 0.6) d = Math.max(d, s.dangerLevel);
    }
    return d;
}

/** Who is about at a place: placements within `radiusKm` and codex layers painted there. */
export function populationAt(world: GameWorld, x: number, y: number, radiusKm = 0.6): Array<{ codex: CodexEntry; count: number; painted: number }> {
    const byId = new Map<string, { codex: CodexEntry; count: number; painted: number }>();
    const codexById = new Map(world.codex.map((c) => [c.id, c]));
    for (const p of placementsNear(world, x, y, radiusKm)) {
        const c = codexById.get(p.codexId);
        if (!c) continue;
        const e = byId.get(c.id) ?? { codex: c, count: 0, painted: 0 };
        e.count += p.count;
        byId.set(c.id, e);
    }
    for (const m of marksAt(world.overlay, world.meta, x, y)) {
        if (!isCodexLayer(m.key)) continue;
        const c = codexById.get(codexIdOfLayer(m.key));
        if (!c) continue;
        const e = byId.get(c.id) ?? { codex: c, count: 0, painted: 0 };
        e.painted = Math.max(e.painted, m.density);
        byId.set(c.id, e);
    }
    return [...byId.values()];
}

/** Everything that ties a codex entry to the map. */
export function codexMapPresence(world: GameWorld, entry: CodexEntry): {
    spots: WorldSpot[];
    placements: CodexPlacement[];
    paintedKm2: number;
    regions: WorldRegion[];
    missions: string[];
} {
    const spots = world.spots.filter((s) => s.linkedCodexIds?.includes(entry.id) || entry.linkedSpotIds?.includes(s.id));
    const placements = placementsOf(world, entry.id);
    const painted = layerCoverage(world.overlay, world.meta).find((c) => c.key === codexLayerKey(entry.id));
    const regionIds = new Set<string>();
    const regions: WorldRegion[] = [];
    const consider = (x: number, y: number) => {
        for (const r of regionsAt(world, x, y)) {
            if (!regionIds.has(r.id)) {
                regionIds.add(r.id);
                regions.push(r);
            }
        }
    };
    placements.forEach((p) => consider(p.x, p.y));
    spots.forEach((s) => consider(s.x, s.y));
    const layer = world.overlay?.layers[codexLayerKey(entry.id)];
    if (layer && world.overlay) {
        const o = world.overlay;
        for (let k = 0; k < layer.length; k++) {
            if (layer[k] > 0.05) {
                const [x, y] = cellCenter(o, world.meta, k % o.cols, Math.floor(k / o.cols));
                consider(x, y);
            }
        }
    }
    for (const r of world.regions) {
        if (r.controllingFactionId === entry.id && !regionIds.has(r.id)) {
            regionIds.add(r.id);
            regions.push(r);
        }
    }
    const missions = world.missions
        .filter((m) =>
            m.giverCodexId === entry.id ||
            m.requiredCodexIds?.includes(entry.id) ||
            m.rewardCodexIds?.includes(entry.id) ||
            m.reputation?.some((r) => r.factionId === entry.id) ||
            Object.values(m.objectiveDetails ?? {}).some((d) => d.targetCodexId === entry.id) ||
            entry.linkedMissionIds?.includes(m.id)
        )
        .map((m) => m.id);
    return { spots, placements, paintedKm2: painted?.areaKm2 ?? 0, regions, missions };
}

/** The label a layer key shows in lists. */
export function layerLabel(world: GameWorld, key: string): string {
    if (isCodexLayer(key)) {
        const c = world.codex.find((e) => e.id === codexIdOfLayer(key));
        return c ? c.name : "(deleted codex entry)";
    }
    return MARK_BY_ID[key]?.label ?? key;
}

export function layerStyle(world: GameWorld, key: string): { color: RGBA; glyph: MarkGlyph } {
    if (isCodexLayer(key)) {
        const c = world.codex.find((e) => e.id === codexIdOfLayer(key));
        const st = CODEX_MAP_STYLE[c?.category ?? "lore"] ?? CODEX_MAP_STYLE.lore;
        return { color: st.color, glyph: st.glyph };
    }
    const m = MARK_BY_ID[key];
    return m ? { color: m.color, glyph: m.glyph } : { color: [0.8, 0.8, 0.8, 0.8], glyph: "dot" };
}

/** Drops placements and painted layers of codex entries that no longer exist. */
export function pruneCodexReferences(world: GameWorld): void {
    const ids = new Set(world.codex.map((c) => c.id));
    if (world.placements) world.placements = world.placements.filter((p) => ids.has(p.codexId));
    if (world.overlay) {
        for (const k of Object.keys(world.overlay.layers)) {
            if (isCodexLayer(k) && !ids.has(codexIdOfLayer(k))) delete world.overlay.layers[k];
        }
    }
}
