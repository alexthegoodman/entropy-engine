// The people of Chapter One, all Mesha: the human (people.human) dressed in Combat Armor or Warden
// Garb, holding a Coil Rifle or a warden's glaive or staff, merged into one mesh per look and
// tagged for the shader's limb animation (ab_shader.ts): uv.y's integer part is the limb (0 rigid,
// 1/2 left/right leg, 3/4 left/right arm, by the side of the body they hang on), its fraction / 0.49
// how much of the limb's swing a vertex takes. The weapon rides the right arm (limb 3: the human
// faces +Z, so their right hand is on -X).
//
// Each look is built once (a few seconds of Mesha evaluation, on the loading screen) and cached
// on disk with two coarser levels of detail (ab_models.ts cluster).

import { evaluateObject, type ParamValues } from "../../apps/mesha/mesha_object";
import { lookupObject } from "../../apps/mesha/library";
import { join, transformMesh, compose4 } from "../../apps/mesha/mesha_mesh";
import { packEvaluation, cluster, type PackedMesh, concat } from "./ab_models";

export type Faction = "surface" | "below";

export interface Look {
    id: string;
    faction: Faction;
    human: ParamValues;
    gear: { object: string; values: ParamValues } | null;
    weapon: { object: string; values: ParamValues; hold: "rifle" | "pole" } | null;
    /** Synthetic soldiers: skin of metal, eyes of light. */
    synthetic?: boolean;
}

const soldierBody = (female: boolean, skin: string, extra: ParamValues = {}): ParamValues => ({
    quality: "draft", masculinity: female ? 0.15 : 1, height: female ? 1.7 : 1.78, muscle: 0.6, weight: 0.3,
    // Under a helmet: no hair (it would push through, and cost more than the rest of the body).
    hairStyle: "none", hairColor: "hair.black", top: "longsleeve", topFinish: "fabric.charcoal", topFit: 0.45,
    bottom: "trousers", bottomFinish: "fabric.charcoal", bottomFit: 0.5, shoes: "boots", shoeFinish: "leather.black", soleFinish: "rubber.black",
    skin, eyeColor: "iris.dark", smile: 0, ...extra,
});

const wardenBody = (female: boolean, skin: string, top: string, bottom: string): ParamValues => ({
    quality: "draft", masculinity: female ? 0.2 : 0.95, height: female ? 1.72 : 1.8, muscle: 0.55, weight: 0.25,
    hairStyle: "none", top: "longsleeve", topFinish: top, bottom: "trousers", bottomFinish: bottom, bottomFit: 0.7,
    shoes: "boots", shoeFinish: "leather.brown", soleFinish: "leather.brown", skin, eyeColor: "iris.amber", smile: 0,
});

const RIFLE = { object: "equipment.coil_rifle", values: {}, hold: "rifle" as const };

export const LOOKS: Look[] = [
    { id: "trooper-m", faction: "surface", human: soldierBody(false, "skin.medium"), gear: { object: "people.combat_armor", values: { height: 1.78 } }, weapon: RIFLE },
    { id: "trooper-f", faction: "surface", human: soldierBody(true, "skin.brown"), gear: { object: "people.combat_armor", values: { height: 1.7 } }, weapon: RIFLE },
    // Sergeant Okafor: visor up, the officer's dark plates.
    { id: "sergeant", faction: "surface", human: soldierBody(true, "skin.deep"), gear: { object: "people.combat_armor", values: { height: 1.7, visor: "up", plateFinish: "composite.black", accentFinish: "glow.white" } }, weapon: { ...RIFLE, values: { kind: "carbine" } } },
    // A synthetic trooper: titanium where the skin would be.
    { id: "synthetic", faction: "surface", synthetic: true, human: soldierBody(false, "skin.light", { hairStyle: "none", height: 1.85, muscle: 0.8 }), gear: { object: "people.combat_armor", values: { height: 1.85, helmet: false, bulk: 1.15, plateFinish: "composite.white", accentFinish: "glow.amber" } }, weapon: RIFLE },
    { id: "warden-m", faction: "below", human: wardenBody(false, "skin.olive", "cloth.wine", "cloth.ash"), gear: { object: "people.warden_garb", values: { height: 1.8 } }, weapon: { object: "equipment.melee_weapon", values: { kind: "glaive" }, hold: "pole" } },
    { id: "warden-f", faction: "below", human: wardenBody(true, "skin.tan", "cloth.ash", "cloth.indigo"), gear: { object: "people.warden_garb", values: { height: 1.72, clothFinish: "cloth.ash", innerFinish: "cloth.indigo", trimFinish: "metal.verdigris" } }, weapon: { object: "equipment.melee_weapon", values: { kind: "staff" }, hold: "pole" } },
    // The casters who throw the river's light: saffron and gold, staffs.
    { id: "adept", faction: "below", human: wardenBody(false, "skin.brown", "cloth.saffron", "cloth.wine"), gear: { object: "people.warden_garb", values: { height: 1.8, clothFinish: "cloth.saffron", innerFinish: "cloth.wine", trimFinish: "metal.gold", glowFinish: "glow.riverGold" } }, weapon: { object: "equipment.melee_weapon", values: { kind: "staff", glowFinish: "glow.riverGold", trimFinish: "metal.gold" }, hold: "pole" } },
    // The Warden who leads them: taller, the ash mantle long, a golden glaive.
    // Chapter Two: Major Voss, bareheaded in the officer's dark plates; Maelis, a healer of below - hood down, no mask, vials of river water at her belt.
    { id: "officer", faction: "surface", human: soldierBody(false, "skin.light", { height: 1.82, muscle: 0.5 }), gear: { object: "people.combat_armor", values: { height: 1.82, helmet: false, plateFinish: "composite.black", accentFinish: "glow.amber" } }, weapon: null },
    { id: "healer", faction: "below", human: wardenBody(true, "skin.olive", "cloth.ash", "cloth.green"), gear: { object: "people.warden_garb", values: { height: 1.68, hood: "down", mask: false, shoulderGuard: false, vials: 8, clothFinish: "cloth.ash", innerFinish: "cloth.green", trimFinish: "metal.verdigris" } }, weapon: null },
    { id: "the-warden", faction: "below", human: { ...wardenBody(false, "skin.tan", "cloth.indigo", "cloth.ash"), height: 1.9 }, gear: { object: "people.warden_garb", values: { height: 1.9, clothFinish: "cloth.ash", innerFinish: "cloth.indigo", mantleLength: 1.3, vials: 6, trimFinish: "metal.gold" } }, weapon: { object: "equipment.melee_weapon", values: { kind: "glaive", trimFinish: "metal.gold", glowFinish: "glow.riverGold", length: 1.15 } , hold: "pole" } },
];

export const lookById = (id: string): Look => {
    const l = LOOKS.find(x => x.id === id);
    if (!l) throw new Error(`Abyss: no look ${id}`);
    return l;
};

/** Hip and shoulder heights of the shader's pivots for a 1.7 m human; others are scaled by matrix. */
export const BASE_HEIGHT = 1.7;

/**
 * Tags every vertex with its limb (see the file comment), by where it sits on a human of
 * `height`: below the hips a leg, out at the sides between hip and shoulder an arm.
 */
export function tagLimbs(m: PackedMesh, height: number, rigidFrom = Infinity): void {
    const k = height / BASE_HEIGHT;
    const v = m.vertexData;
    const n = v.length / 12;
    for (let i = 0; i < n; i++) {
        if (i >= rigidFrom) break;
        const o = i * 12;
        const x = v[o] / k, y = v[o + 1] / k;
        let limb = 0, weight = 0;
        if (y < 0.95) { limb = x < 0 ? 1 : 2; weight = Math.min(1, Math.max(0, (0.95 - y) / 0.16)); }
        const pattern = Math.round(Math.hypot(v[o + 3], v[o + 4], v[o + 5])) - 1;
        if (Math.abs(x) > 0.19 && y > 0.6 && y < 1.5 && pattern !== 18) {
            limb = x < 0 ? 3 : 4; weight = Math.min(1, Math.max(0, (Math.abs(x) - 0.19) / 0.065));
        }
        v[o + 7] = limb + weight * 0.49;
    }
}

/** Every vertex of `m` on one limb at full weight (a weapon in the hand). */
function tagAll(m: PackedMesh, limb: number): void {
    for (let o = 0; o < m.vertexData.length; o += 12) m.vertexData[o + 7] = limb + 0.49;
}

/** The right hand's center for the human mesh (skin below the hip on -X). */
function rightHand(m: PackedMesh, height: number): [number, number, number] {
    const k = height / BASE_HEIGHT;
    let sx = 0, sy = 0, sz = 0, c = 0;
    const v = m.vertexData;
    for (let o = 0; o < v.length; o += 12) {
        const pattern = Math.round(Math.hypot(v[o + 3], v[o + 4], v[o + 5])) - 1;
        if (pattern !== 17) continue;
        const x = v[o] / k, y = v[o + 1] / k;
        if (x < -0.17 && y > 0.66 && y < 0.82) { sx += v[o]; sy += v[o + 1]; sz += v[o + 2]; c++; }
    }
    return c ? [sx / c, sy / c, sz / c] : [-0.25 * k, 0.76 * k, 0.03 * k];
}

/** Metal skin and light for eyes (a synthetic). */
function synthesize(m: PackedMesh): void {
    const v = m.vertexData;
    for (let o = 0; o < v.length; o += 12) {
        const len = Math.hypot(v[o + 3], v[o + 4], v[o + 5]);
        const pattern = Math.round(len) - 1;
        if (pattern === 17) {
            // Brushed titanium (pattern 3), metal flag in alpha.
            const s = 4 / len;
            v[o + 3] *= s; v[o + 4] *= s; v[o + 5] *= s;
            v[o + 8] = 0.62; v[o + 9] = 0.64; v[o + 10] = 0.66; v[o + 11] = 0.5 + 0.49 * 0.3;
        } else if (pattern === 19) {
            // Irises glow amber.
            const s = 12 / len;
            v[o + 3] *= s; v[o + 4] *= s; v[o + 5] *= s;
            v[o + 8] = 1; v[o + 9] = 0.65; v[o + 10] = 0.2;
        }
    }
}

/** Builds a look's full mesh: human + gear + weapon, tagged. Takes seconds (the human). */
export function buildLook(look: Look): PackedMesh {
    const height = Number(look.human.height ?? 1.75);
    const humanDef = lookupObject("people.human")!;
    const human = packEvaluation(evaluateObject(humanDef, look.human, lookupObject));
    if (look.synthetic) synthesize(human);
    const parts: PackedMesh[] = [human];
    if (look.gear) {
        const def = lookupObject(look.gear.object)!;
        parts.push(packEvaluation(evaluateObject(def, look.gear.values, lookupObject)));
    }
    const body = concat(parts);
    tagLimbs(body, height);
    if (!look.weapon) return body;
    const hand = rightHand(human, height);
    const wdef = lookupObject(look.weapon.object)!;
    const we = evaluateObject(wdef, look.weapon.values, lookupObject);
    // A rifle hangs barrel-down along the arm (it comes up level when the arm does); a pole stands upright in the fist.
    const m = look.weapon.hold === "rifle"
        ? compose4([hand[0], hand[1], hand[2]], [Math.PI / 2, 0, 0])
        : compose4([hand[0], hand[1] - 0.02, hand[2] + 0.02], [0.12, 0, 0]);
    const weapon = packEvaluation({ ...we, mesh: transformMesh(we.mesh, m) });
    tagAll(weapon, 3);
    return concat([body, weapon]);
}

/** Cell sizes (m) of the coarser levels. */
export const PERSON_LOD_CELLS = [0.022, 0.06] as const;
/** Camera distances (m) where a person drops to the next level. */
export const PERSON_LOD_RANGES = [14, 45] as const;

export function personLods(full: PackedMesh): PackedMesh[] {
    return [full, cluster(full, PERSON_LOD_CELLS[0]), cluster(full, PERSON_LOD_CELLS[1])];
}

export function personLod(distance: number, detail = 1): 0 | 1 | 2 {
    const d = distance / Math.max(0.1, detail);
    return d < PERSON_LOD_RANGES[0] ? 0 : d < PERSON_LOD_RANGES[1] ? 1 : 2;
}

/** The mesh-cache key of a look's level. Bump the version when looks or the packing change. */
export const PEOPLE_VERSION = 1;
export const lookKey = (id: string, lod: number): string => `person-v${PEOPLE_VERSION}-${id}-lod${lod}`;

export { join, transformMesh };
