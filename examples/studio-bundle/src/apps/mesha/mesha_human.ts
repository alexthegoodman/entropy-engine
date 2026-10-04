// A whole person: the figure (mesha_figure), dressed (mesha_cloth: draped garments and shoes) and
// groomed (mesha_hair: styled, settled strands, brows, lashes, beard). Each stage is cached on the
// inputs that shape it, so changing a hair color re-evaluates nothing, a hairstyle regrows only the
// hair, and a sleeve length re-drapes the clothes over the same body. "draft" quality builds a
// coarser person quickly (for dragging a slider); "final" is the one to look at and export.

import { type Mesh } from "./mesha_mesh";
import { buildFigure, DEFAULT_FIGURE, type FigureParams, type PoseName } from "./mesha_figure";
import { dress, footwear, shoeLift, DEFAULT_OUTFIT, type OutfitParams, type ShoeKind, type Outfit } from "./mesha_cloth";
import { growHair, DEFAULT_HAIR, type HairParams } from "./mesha_hair";

export type Quality = "draft" | "final";

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
