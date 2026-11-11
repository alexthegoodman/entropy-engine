// A whole person: the figure (mesha_figure), dressed (mesha_cloth: draped garments and shoes) and
// groomed (mesha_hair: styled, settled strands, brows, lashes, beard). Each stage is cached on the
// inputs that shape it, so changing a hair color re-evaluates nothing, a hairstyle regrows only the
// hair, and a sleeve length re-drapes the clothes over the same body. "draft" quality builds a
// coarser person quickly (for dragging a slider); "final" is the one to look at and export.
// "game" is the person a level shows by the hundred: the coarse body alone, with the clothes, shoes
// and hair painted onto its skin as their own regions (and materials), no cloth or strand
// simulation at all - a fraction of the triangles and of the time.

import { type Mesh, type Part, type Vec3, newPart } from "./mesha_mesh";
import { buildFigure, DEFAULT_FIGURE, m3apply, m3transpose, type BoneName, type FigureHandle, type FigureParams, type PoseName } from "./mesha_figure";
import { dress, footwear, shoeLift, DEFAULT_OUTFIT, type OutfitParams, type ShoeKind, type Outfit } from "./mesha_cloth";
import { growHair, DEFAULT_HAIR, type HairParams } from "./mesha_hair";

export type Quality = "draft" | "final" | "game";

export interface HumanParams extends Omit<FigureParams, "toes" | "sole" | "heel" | "detail" | "pose"> {
    pose: PoseName;
    outfit: Omit<OutfitParams, "detail" | "settle" | "seed" | "wind">;
    shoes: ShoeKind;
    hair: Omit<HairParams, "detail" | "settle" | "seed" | "wind">;
    /** Wind the clothes and hair settle in (m/s). */
    wind: number;
    quality: Quality;
}

class Lru<V> {
    private map = new Map<string, V>();
    constructor(private size: number) {}
    get(key: string, make: () => V): V {
        const hit = this.map.get(key);
        if (hit !== undefined) { this.map.delete(key); this.map.set(key, hit); return hit; }
        const v = make();
        this.map.set(key, v);
        while (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string);
        return v;
    }
}

const outfits = new Lru<Outfit>(4);
const shoeMeshes = new Lru<Mesh>(4);
const hairs = new Lru<Mesh>(6);

/** Builds (or reuses) a person. */
export function buildHuman(p: HumanParams): Mesh {
    if (p.quality === "game") return buildGameHuman(p);
    const draft = p.quality === "draft";
    const lift = shoeLift(p.shoes);
    const { outfit: _o, shoes: _s, hair: _h, wind: _w, quality: _q, ...body } = p;
    const figureParams: Partial<FigureParams> = { ...body, toes: p.shoes === "none", sole: lift.sole, heel: lift.heel, detail: draft ? 2.6 : 1 };
    const figure = buildFigure(figureParams);
    const figureKey = JSON.stringify(figureParams);
    const outfitParams: Partial<OutfitParams> = { ...p.outfit, wind: p.wind, seed: p.seed, detail: draft ? 2.2 : 1, settle: draft ? 10 : DEFAULT_OUTFIT.settle };
    const outfitKey = figureKey + JSON.stringify(outfitParams);
    const outfit = outfits.get(outfitKey, () => dress(figure.handle, outfitParams));
    const shoes = shoeMeshes.get(figureKey + p.shoes, () => footwear(figure.handle, p.shoes, draft ? 2 : 1));
    const hairParams: Partial<HairParams> = { ...p.hair, wind: p.wind, seed: p.seed, detail: draft ? 2.5 : 1, settle: draft ? 10 : DEFAULT_HAIR.settle };
    const hair = hairs.get(outfitKey + JSON.stringify(hairParams), () => growHair(figure.handle, outfit.under, hairParams).mesh);
    return { parts: [...figure.mesh.parts, ...outfit.mesh.parts, ...shoes.parts, ...hair.parts] };
}

export const DEFAULT_HUMAN: HumanParams = (() => {
    const { toes: _t, sole: _s, heel: _h, detail: _d, ...body } = DEFAULT_FIGURE;
    const { detail: _od, settle: _os, seed: _oseed, wind: _ow, ...outfit } = DEFAULT_OUTFIT;
    const { detail: _hd, settle: _hs, seed: _hseed, wind: _hw, ...hair } = DEFAULT_HAIR;
    return { ...body, outfit, shoes: "sneakers", hair, wind: 0, quality: "final" };
})();

// --- "game" quality: clothes and hair painted on ----------------------------------------------

type Limb = "head" | "neck" | "torso" | "pelvis" | "arm" | "hand" | "leg" | "foot";
/** Rough thickness (m, for a 1.7 m person) of each limb about its bones: points go to the nearest surface, not the nearest axis. */
const LIMB_RADIUS: Record<Limb, number> = { head: 0.09, neck: 0.055, torso: 0.13, pelvis: 0.13, arm: 0.045, hand: 0.03, leg: 0.075, foot: 0.04 };
const LIMB_BONES: Array<[BoneName, Limb, number, number]> = [
    // bone, limb, and where the bone starts and ends along its limb chain (0..1: shoulder to wrist, hip to ankle)
    ["head", "head", 0, 1], ["neck", "neck", 0, 1], ["chest", "torso", 0, 1], ["spine", "torso", 0, 1], ["clavicleL", "torso", 0, 1], ["clavicleR", "torso", 0, 1],
    ["pelvis", "pelvis", 0, 1],
    ["upperarmL", "arm", 0, 0.5], ["forearmL", "arm", 0.5, 1], ["handL", "hand", 0, 1], ["upperarmR", "arm", 0, 0.5], ["forearmR", "arm", 0.5, 1], ["handR", "hand", 0, 1],
    ["thighL", "leg", 0, 0.5], ["shinL", "leg", 0.5, 1], ["footL", "foot", 0, 1], ["toesL", "foot", 0, 1],
    ["thighR", "leg", 0, 0.5], ["shinR", "leg", 0.5, 1], ["footR", "foot", 0, 1], ["toesR", "foot", 0, 1],
];

/** Which painted region a point of the skin takes, from the limb it is on and the outfit. */
function paintRegion(p: HumanParams, h: FigureHandle, limb: Limb, along: number, at: Vec3): string {
    const o = p.outfit;
    const dress = o.top === "dress";
    switch (limb) {
        case "head": {
            const style = p.hair.style;
            const hd = h.head;
            const l = m3apply(m3transpose(hd.R), [at[0] - hd.center[0], at[1] - hd.center[1], at[2] - hd.center[2]]);
            const x = l[0] / hd.radii[0], y = l[1] / hd.radii[1], z = l[2] / hd.radii[2];
            if (style !== "none" && ((y > 0.18 && z < 0.5) || (y > 0.42) || (z < -0.15 && y > -0.6 && Math.abs(x) < 1.05))) return "hairCap";
            if ((p.hair.beard === "short" || p.hair.beard === "full") && z > 0.2 && y < -0.62) return "beard";
            return "skin";
        }
        case "neck": return o.top === "sweater" && along < 0.45 ? "top" : "skin";
        case "torso": return o.top !== "none" ? "top" : "skin";
        case "pelvis": return dress ? "top" : o.bottom !== "none" ? "bottom" : o.top !== "none" && o.topLength >= 1 ? "top" : "skin";
        case "arm": {
            if (o.top === "none") return "skin";
            // The armpit and shoulder belong to the top whatever the sleeve.
            if (along < 0.1) return "top";
            if (o.top === "tank") return "skin";
            const sleeve = o.top === "longsleeve" || o.top === "sweater" ? Math.max(o.sleeve, 0.92) : o.sleeve;
            return along <= 0.08 + 0.92 * Math.max(0, Math.min(1, sleeve)) ? "top" : "skin";
        }
        case "hand": return "skin";
        case "leg": {
            const len = Math.max(0, Math.min(1, o.bottomLength));
            if (dress || o.bottom === "skirt") return along <= len * 1.15 - 0.15 ? (dress ? "top" : "bottom") : p.shoes === "boots" && along > 0.82 ? "shoes" : "skin";
            if (o.bottom === "none") return p.shoes === "boots" && along > 0.82 ? "shoes" : "skin";
            const cover = o.bottom === "shorts" ? Math.min(len, 0.5) : len;
            if (along <= cover) return "bottom";
            return p.shoes === "boots" && along > 0.82 ? "shoes" : "skin";
        }
        case "foot": return p.shoes === "none" ? "skin" : at[1] < 0.02 ? "soles" : "shoes";
    }
}

function distanceToSegment(q: Vec3, a: Vec3, b: Vec3): { d: number; t: number } {
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / l2));
    return { d: Math.hypot(q[0] - a[0] - ab[0] * t, q[1] - a[1] - ab[1] * t, q[2] - a[2] - ab[2] * t), t };
}

const gameHumans = new Lru<Mesh>(8);

/**
 * A person for a level: the coarse figure, its skin split into the outfit's regions by the bone each
 * point lies nearest (a sleeve covers its share of the arm, trousers theirs of the leg, the scalp
 * takes the hair color), so it keeps its colors and silhouette without a single draped or grown
 * strand. Corneas go too (a level never shows them).
 */
export function buildGameHuman(p: HumanParams): Mesh {
    const { outfit: _o, shoes: _s, hair: _h, wind: _w, quality: _q, ...body } = p;
    const figureParams: Partial<FigureParams> = { ...body, toes: false, sole: 0, heel: 0, detail: 3 };
    const key = JSON.stringify([figureParams, p.outfit, p.shoes, p.hair.style, p.hair.beard]);
    return gameHumans.get(key, () => {
        const figure = buildFigure(figureParams);
        const h = figure.handle;
        const k = (p.height ?? 1.7) / 1.7;
        const segs = LIMB_BONES.filter(([b]) => h.skeleton.bones.has(b)).map(([bone, limb, t0, t1]) => ({ a: h.joint(bone, 0), b: h.joint(bone, limb === "hand" ? 1.9 : 1), limb, t0, t1, r: LIMB_RADIUS[limb] * k }));
        const parts = new Map<string, Part>();
        const out: Part[] = [];
        for (const src of figure.mesh.parts) {
            if (src.region === "cornea") continue;
            if (src.region !== "skin") { out.push(src); continue; }
            const P = src.positions, N = src.normals, U = src.uvs, I = src.indices;
            const nv = P.length / 3;
            const regionOf: string[] = new Array(nv);
            for (let v = 0; v < nv; v++) {
                const q: Vec3 = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
                let best = segs[0], bestD = Infinity, bestT = 0;
                for (const s of segs) {
                    const r = distanceToSegment(q, s.a, s.b);
                    // A hand and forearm hang by the hip: only what is really on them (fingers included) is theirs.
                    if (s.limb === "hand" && r.d > 0.05 * k) continue;
                    if (s.limb === "arm" && s.t0 > 0 && r.d > 0.065 * k) continue;
                    const d = r.d - s.r;
                    if (d < bestD) { bestD = d; best = s; bestT = r.t; }
                }
                regionOf[v] = paintRegion(p, h, best.limb, best.t0 + (best.t1 - best.t0) * bestT, q);
            }
            const remap = new Map<string, Int32Array>();
            for (let t = 0; t < I.length; t += 3) {
                const a = I[t], b = I[t + 1], c = I[t + 2];
                // A triangle takes the region most of its corners have (skin on a three-way tie).
                const ra = regionOf[a], rb = regionOf[b], rc = regionOf[c];
                const r = ra === rb || ra === rc ? ra : rb === rc ? rb : ra === "skin" || rb === "skin" || rc === "skin" ? "skin" : ra;
                let part = parts.get(r);
                if (!part) { part = newPart(r); parts.set(r, part); remap.set(r, new Int32Array(nv).fill(-1)); }
                const map = remap.get(r)!;
                for (const i of [a, b, c]) {
                    if (map[i] < 0) {
                        map[i] = part.positions.length / 3;
                        part.positions.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
                        part.normals.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
                        part.uvs.push(U[i * 2] ?? 0, U[i * 2 + 1] ?? 0);
                    }
                    part.indices.push(map[i]);
                }
            }
        }
        return { parts: [...parts.values(), ...out] };
    });
}
