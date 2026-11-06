// Scatter: what grows (or lies) where the Planner painted forest, meadow, rock, snow... Each mark
// has a layer (detail_types.ts ScatterLayer; defaults in detail_models.ts): instances per hectare
// at full paint and a weighted list of Mesha objects with a size range and a few variants.
//
// Scatter is generated per square tile of the ground grid, from a seed made of the tile and the
// layer, so a tile always grows the same plants: the viewport streams tiles around the camera and
// the export writes the same instances. Plants keep off water, roads, streets, plazas and building
// pads, and off ground too steep for them. Variants (seeds) are few on purpose: every instance of
// one variant at one level of detail is drawn by one instanced draw.

import { PRNG } from "../game_planner/terrain";
import type { Ground } from "./detail_ground";
import { DEFAULT_SCATTER } from "./detail_models";
import { hashString } from "./detail_scene";
import type { ModelChoice, ScatterLayer, WorldDetail } from "./detail_types";

export interface ScatterInstance {
    layer: string;
    /** The variant's model: the item's values with its variant seed. */
    model: ModelChoice;
    /** Stable identity of the variant (instances of one key share a mesh). */
    variantKey: string;
    x: number;
    y: number;
    elevation: number;
    yaw: number;
    scale: number;
}

/** Scatter layers in effect: the world's own, else the defaults, for marks that are painted. */
export function scatterLayers(detail: WorldDetail, paintedKeys: string[]): Record<string, ScatterLayer> {
    const out: Record<string, ScatterLayer> = {};
    for (const k of paintedKeys) {
        const layer = detail.scatter[k] ?? DEFAULT_SCATTER[k];
        if (layer?.enabled && layer.items.length && layer.perHectare > 0) out[k] = layer;
    }
    return out;
}

/** Steepest ground (degrees) an object of this kind grows on. */
function maxSlopeFor(objectId: string): number {
    if (objectId === "nature.rock") return 60;
    if (objectId.startsWith("nature.grass") || objectId === "nature.flowers" || objectId === "nature.fern") return 40;
    return 32;
}

export interface ScatterOptions {
    /** 0..1 of each layer's density (the viewport thins; the export uses 1). */
    density?: number;
    /** Cap per tile and layer, a guard against an absurd per-hectare value. */
    maxPerLayer?: number;
}

/**
 * The scatter of one tile: `tx`, `ty` index a grid of `tileKm` tiles in world km (tile (0, 0)
 * spans x in [0, tileKm), y in [0, tileKm)).
 */
export function scatterTile(ground: Ground, detail: WorldDetail, tx: number, ty: number, tileKm: number, opts: ScatterOptions = {}): ScatterInstance[] {
    const world = ground.world;
    const painted = Object.keys(world.overlay?.layers ?? {});
    const layers = scatterLayers(detail, painted);
    const density = Math.max(0, Math.min(1, opts.density ?? 1));
    const out: ScatterInstance[] = [];
    const haPerTile = tileKm * tileKm * 100;
    const W = world.meta.worldWidthKm / 2, H = world.meta.worldHeightKm / 2;
    for (const [key, layer] of Object.entries(layers)) {
        // Is anything painted near this tile at all? (Cheap: five samples.)
        const x0 = tx * tileKm, y0 = ty * tileKm;
        const probe = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].reduce((m, [u, v]) => Math.max(m, ground.markDensity(key, x0 + u * tileKm, y0 + v * tileKm)), 0);
        if (probe <= 0.01) continue;
        const rng = new PRNG(hashString(`${key}|${tx}|${ty}|${world.meta.seed}`));
        const candidates = Math.min(opts.maxPerLayer ?? 4000, Math.round(layer.perHectare * haPerTile * density));
        const total = layer.items.reduce((s, it) => s + Math.max(0, it.weight), 0) || 1;
        for (let n = 0; n < candidates; n++) {
            const x = x0 + rng.next() * tileKm, y = y0 + rng.next() * tileKm;
            // Pick the item before the rejection tests so the stream of numbers is the same
            // whatever a test decides (a nudge to one plant never reshuffles the rest).
            let pick = rng.next() * total, idx = 0;
            for (; idx < layer.items.length - 1; idx++) { pick -= Math.max(0, layer.items[idx].weight); if (pick <= 0) break; }
            const it = layer.items[idx];
            const variant = Math.floor(rng.next() * Math.max(1, it.variants));
            const yaw = rng.next() * Math.PI * 2;
            const scale = it.minScale + (it.maxScale - it.minScale) * rng.next();
            const keep = rng.next();
            if (x < -W || x > W || y < -H || y > H) continue;
            if (keep > ground.markDensity(key, x, y)) continue;
            const s = ground.sample(x, y, true);
            if (s.surface?.occupied) continue;
            if (ground.slopeDeg(x, y) > maxSlopeFor(it.objectId)) continue;
            const baseSeed = Number(it.values.seed ?? 1);
            const values = { ...it.values, seed: baseSeed + variant * 101 };
            out.push({
                layer: key, model: { objectId: it.objectId, values }, variantKey: `${it.objectId}|${JSON.stringify(values, Object.keys(values).sort())}`,
                x, y, elevation: s.h - 0.05, yaw, scale,
            });
        }
    }
    return out;
}

/** Tiles (indices) overlapping a circle. */
export function tilesAround(x: number, y: number, radiusKm: number, tileKm: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let tx = Math.floor((x - radiusKm) / tileKm); tx <= Math.floor((x + radiusKm) / tileKm); tx++) {
        for (let ty = Math.floor((y - radiusKm) / tileKm); ty <= Math.floor((y + radiusKm) / tileKm); ty++) {
            const cx = Math.max(tx * tileKm, Math.min(x, (tx + 1) * tileKm)), cy = Math.max(ty * tileKm, Math.min(y, (ty + 1) * tileKm));
            if (Math.hypot(cx - x, cy - y) <= radiusKm) out.push([tx, ty]);
        }
    }
    return out;
}
