// The level as placed objects: the plan (structures, spot landmarks, codex placements) and the
// Detailer's own props, each resolved to a Mesha model (or a simple builtin) with a ground
// position, a turn and a scale. The viewport draws this list, picking hits it, and the export
// writes it out; scatter (trees, grass, rocks from painted marks) is generated per area by
// detail_scatter.ts instead, because a whole world of it would be millions of things.
//
// Positions stay in the plan's world km (x east, y north); heights come from the Ground.

import type { CodexPlacement, GameWorld, WorldSpot, WorldStructure } from "../game_planner/planner_types";
import { isFootprint, isLine, STRUCTURE_KINDS } from "../game_planner/town_planning";
import { PRNG } from "../game_planner/terrain";
import type { Ground } from "./detail_ground";
import { builtinFor, defaultCategoryModel, defaultSpotModel, defaultStructureModel, fitModel, footprintPieces, GROUND_KINDS, type BuiltinKind } from "./detail_models";
import type { DetailProp, EntityBinding, ModelChoice, WorldDetail } from "./detail_types";

export type SourceKind = "structure" | "spot" | "placement" | "prop";

export interface BuiltinShape {
    kind: BuiltinKind;
    /** Meters: length along x, height, thickness/depth along z. */
    size: [number, number, number];
}

export interface SceneItem {
    /** Unique and stable while the plan doesn't change: "structure:<id>#<piece>". */
    key: string;
    source: SourceKind;
    /** The planner entity (or prop) id; editing an item edits this. */
    sourceId: string;
    name: string;
    /** The model, already fitted to its footprint; null for a builtin. */
    model: ModelChoice | null;
    builtin?: BuiltinShape;
    /** Where it stands, world km. */
    x: number;
    y: number;
    /** Meters: the ground's height at (x, y), plus any lift. */
    elevation: number;
    /** Radians about +Y (0: front faces +Z, which is south on the map). */
    yaw: number;
    scale: number;
    /** Footprint in meters (for picking and the export), when the plan gives one. */
    footprint?: [number, number];
    hidden: boolean;
    /** Where the model came from: "binding" (this thing's own), "kind" (its kind's, set here), "default". */
    origin: "binding" | "kind" | "default" | "prop";
}

const deg = (d: number) => (d * Math.PI) / 180;

/** Model for a key in `detail.models`, else the fallback. */
function kindModel(detail: WorldDetail, key: string, fallback: ModelChoice | null): { model: ModelChoice | null; origin: SceneItem["origin"] } {
    const m = detail.models[key];
    return m ? { model: m, origin: "kind" } : { model: fallback, origin: "default" };
}

/** Rotates a local offset (m, x right, z front) by yaw and returns world km. */
function offsetKm(x: number, y: number, yaw: number, lx: number, lz: number): [number, number] {
    // Local +x is east and local +z south (-y) at yaw 0; yaw turns counter-clockwise seen from above.
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ex = lx * c + lz * s, sz = -lx * s + lz * c;
    return [x + ex / 1000, y - sz / 1000];
}

function structureItems(world: GameWorld, detail: WorldDetail, ground: Ground, s: WorldStructure): SceneItem[] {
    const binding: EntityBinding = detail.bindings[s.id] ?? {};
    if (GROUND_KINDS.has(s.kind) && !binding.model) return [];
    const name = s.name || STRUCTURE_KINDS[s.kind]?.label || s.kind;
    const hidden = !!binding.hidden;
    const yaw = deg(s.rotationDeg + (binding.yawDeg ?? 0));
    const builtin = builtinFor(s.kind);
    if (isLine(s.shape)) {
        // Walls: a run of stone segments along the line.
        if (s.kind !== "wall" || binding.model) return [];
        const out: SceneItem[] = [];
        const width = s.widthM || STRUCTURE_KINDS.wall.lineWidthM || 4;
        const height = Math.max(3, (s.floors || 2) * 3);
        const pts = s.points ?? [];
        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
            const len = Math.hypot(bx - ax, by - ay) * 1000;
            if (len < 0.5) continue;
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            // The segment runs along local x: yaw so +x points from a to b.
            const segYaw = Math.atan2(by - ay, bx - ax);
            const lowest = Math.min(ground.heightAt(ax, ay), ground.heightAt(bx, by), ground.heightAt(mx, my));
            out.push({
                key: `structure:${s.id}#${i}`, source: "structure", sourceId: s.id, name, model: null,
                builtin: { kind: "wall", size: [len + width * 0.5, height, width] },
                x: mx, y: my, elevation: lowest - 0.6, yaw: segYaw, scale: 1, footprint: [len, width], hidden, origin: "default",
            });
        }
        return out;
    }
    if (!isFootprint(s.shape) && !binding.model) return [];
    const pad = ground.padHeight(s.id);
    const pieces = binding.model ? [{ x: 0, z: 0, w: s.widthM, d: s.depthM }] : footprintPieces(s);
    const resolved = binding.model ? { model: binding.model, origin: "binding" as const } : kindModel(detail, `structure:${s.kind}`, defaultStructureModel(world.meta.genre, s.kind));
    const out: SceneItem[] = [];
    pieces.forEach((piece, i) => {
        const off = binding.offset ?? [0, 0, 0];
        const [x, y] = offsetKm(s.x, s.y, yaw, piece.x + off[0], piece.z + off[2]);
        const elevation = (pad ?? ground.heightAt(x, y)) + off[1];
        const item: SceneItem = {
            key: `structure:${s.id}#${i}`, source: "structure", sourceId: s.id, name, model: null,
            x, y, elevation, yaw, scale: binding.scale ?? 1, footprint: [piece.w, piece.d], hidden, origin: resolved.origin,
        };
        if (resolved.model && !(builtin && resolved.origin === "default")) {
            const fitted = fitModel(resolved.model, piece.w, piece.d, s.floors ?? STRUCTURE_KINDS[s.kind]?.floors ?? 0);
            item.model = fitted.model;
            item.scale *= fitted.scale;
        } else if (builtin) {
            const size: [number, number, number] = builtin === "well" ? [piece.w, 1.1, piece.d] : builtin === "dock" ? [piece.w, 1.2, piece.d] : [piece.w, 3, piece.d];
            item.builtin = { kind: builtin, size };
            if (builtin === "dock") item.elevation = Math.max(elevation, ground.seaLevelM) + 0.4;
        } else return;
        out.push(item);
    });
    return out;
}

const SETTLEMENT_TYPES = new Set(["capital", "city", "town", "village"]);

function spotItems(world: GameWorld, detail: WorldDetail, ground: Ground, s: WorldSpot, builtUp: Set<string>): SceneItem[] {
    const binding: EntityBinding = detail.bindings[s.id] ?? {};
    // A settlement is its buildings; a place with buildings of its own needs no landmark.
    if (!binding.model && (SETTLEMENT_TYPES.has(s.spotType) || builtUp.has(s.id))) return [];
    const resolved = binding.model ? { model: binding.model, origin: "binding" as const } : kindModel(detail, `spot:${s.spotType}`, defaultSpotModel(s.spotType));
    if (!resolved.model) return [];
    const off = binding.offset ?? [0, 0, 0];
    const yaw = deg(binding.yawDeg ?? 0);
    const [x, y] = offsetKm(s.x, s.y, 0, off[0], off[2]);
    const snapped = s.snapToGround !== false;
    const elevation = (snapped ? ground.heightAt(x, y) : s.elevation) + off[1];
    const fitted = fitModel(resolved.model, 20, 20, 0);
    return [{
        key: `spot:${s.id}`, source: "spot", sourceId: s.id, name: s.name, model: fitted.model,
        x, y, elevation, yaw, scale: (binding.scale ?? 1) * fitted.scale, hidden: !!binding.hidden, origin: resolved.origin,
    }];
}

function placementItems(world: GameWorld, detail: WorldDetail, ground: Ground, p: CodexPlacement): SceneItem[] {
    const entry = world.codex.find((c) => c.id === p.codexId);
    if (!entry) return [];
    const binding: EntityBinding = detail.bindings[p.id] ?? {};
    let resolved: { model: ModelChoice | null; origin: SceneItem["origin"] };
    if (binding.model) resolved = { model: binding.model, origin: "binding" };
    else if (detail.models[`codex:${entry.id}`]) resolved = { model: detail.models[`codex:${entry.id}`], origin: "kind" };
    else resolved = kindModel(detail, `category:${entry.category}`, defaultCategoryModel(entry.category));
    if (!resolved.model) return [];
    const n = Math.max(1, Math.min(24, Math.round(p.count || 1)));
    const rng = new PRNG(hashString(p.id));
    const out: SceneItem[] = [];
    // A group stands in a loose cluster around its point, each facing roughly outward.
    const spacing = entry.category === "creature" ? 7 : 1.6;
    const off = binding.offset ?? [0, 0, 0];
    for (let i = 0; i < n; i++) {
        const ring = i === 0 ? 0 : Math.sqrt(i) * spacing;
        const a = i * 2.39996 + rng.range(-0.3, 0.3);
        const [x, y] = offsetKm(p.x, p.y, 0, Math.cos(a) * ring + off[0], Math.sin(a) * ring + off[2]);
        out.push({
            key: `placement:${p.id}#${i}`, source: "placement", sourceId: p.id, name: n > 1 ? `${entry.name} ${i + 1}` : entry.name, model: resolved.model,
            x, y, elevation: ground.heightAt(x, y) + off[1], yaw: deg(binding.yawDeg ?? 0) + (i === 0 ? 0 : a + Math.PI / 2 + rng.range(-0.6, 0.6)),
            scale: binding.scale ?? 1, hidden: !!binding.hidden, origin: resolved.origin,
        });
    }
    return out;
}

function propItem(ground: Ground, p: DetailProp): SceneItem {
    return {
        key: `prop:${p.id}`, source: "prop", sourceId: p.id, name: p.name ?? p.objectId.split(".").pop()!.replace(/_/g, " "),
        model: { objectId: p.objectId, values: p.values }, x: p.x, y: p.y, elevation: ground.heightAt(p.x, p.y) + (p.lift || 0),
        yaw: deg(p.yawDeg || 0), scale: p.scale || 1, hidden: false, origin: "prop",
    };
}

export function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) || 1;
}

/** Every placed object of the level (see the top of this file). */
export function buildSceneItems(world: GameWorld, detail: WorldDetail, ground: Ground): SceneItem[] {
    const out: SceneItem[] = [];
    const builtUp = new Set((world.structures ?? []).map((s) => s.spotId).filter((id): id is string => !!id));
    for (const s of world.structures ?? []) out.push(...structureItems(world, detail, ground, s));
    for (const s of world.spots) out.push(...spotItems(world, detail, ground, s, builtUp));
    for (const p of world.placements ?? []) out.push(...placementItems(world, detail, ground, p));
    for (const p of detail.props) out.push(propItem(ground, p));
    return out;
}

/** Items within `radiusKm` of a point (the export's site, the outliner's neighborhood). */
export function itemsNear(items: SceneItem[], x: number, y: number, radiusKm: number): SceneItem[] {
    return items.filter((i) => Math.hypot(i.x - x, i.y - y) <= radiusKm);
}
