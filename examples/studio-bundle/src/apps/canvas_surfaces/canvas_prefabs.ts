/** Ready-made blocked-out props built from the four surface kinds. Each prefab is a list of parts in a
 * group's local space (origin on the ground, +Y up, front is +Z), so placing one is a position and a
 * yaw. Parts are flat-coloured: the artist paints over them. Pure data, no engine calls. */
export type PartKind = "plane" | "box" | "cylinder" | "sphere";
export type RGB = [number, number, number];
export interface PrefabPart {
    name: string; kind: PartKind;
    halfW?: number; halfH?: number; halfD?: number; radius?: number;
    position: [number, number, number];
    yaw?: number; pitch?: number; roll?: number;
    scale?: [number, number, number];
    color: RGB;
    /** Blocks the player in Play. */
    solid?: boolean;
    /** Cut the surface's alpha mask into a shape (a house's triangular gable end). */
    mask?: "gable";
}
export interface PrefabInfo {
    id: string;
    description: string;
    /** Parameter name -> what it does and its default, for the tool listing. */
    params: Record<string, string>;
    build(params: Record<string, unknown>): { parts: PrefabPart[]; /** Rough radius on the ground, for spacing things out. */ footprint: number };
}

const HALF_PI = Math.PI / 2;

/** [r, g, b] in 0-255, or "#rrggbb". */
export function parseColor(value: unknown, fallback: RGB, name = "color"): RGB {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as RGB;
    if (Array.isArray(value) && value.length === 3 && value.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 255)) return value.map(Math.round) as RGB;
    throw new Error(`${name} must be [r, g, b] (0-255) or "#rrggbb".`);
}
function num(params: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
    const v = params[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`${key} must be a number from ${min} to ${max}.`);
    return v;
}
const color = (p: Record<string, unknown>, key: string, fallback: RGB) => parseColor(p[key], fallback, key);

const house: PrefabInfo = {
    id: "house", description: "Cottage: box walls, two roof slabs, two triangular gable ends and a front door. 6 surfaces.",
    params: { width: "x size, 4", depth: "z size, 4", wallHeight: "2.4", roofHeight: "1.3", wallColor: "[214,190,150]", roofColor: "[150,70,55]", doorColor: "[92,60,40]" },
    build(p) {
        const w = num(p, "width", 4, 2, 20), d = num(p, "depth", 4, 2, 20), wh = num(p, "wallHeight", 2.4, 1.5, 8), rh = num(p, "roofHeight", 1.3, 0.4, 6);
        const wall = color(p, "wallColor", [214, 190, 150]), roof = color(p, "roofColor", [150, 70, 55]), door = color(p, "doorColor", [92, 60, 40]);
        const half = w / 2, overhang = 0.35, thick = 0.16, theta = Math.atan2(rh, half);
        // Slab from the eave (overhanging the wall) up to the ridge, lifted half its thickness along its normal.
        const eaveX = half + overhang, eaveY = wh - overhang * Math.tan(theta);
        const length = Math.hypot(eaveX, wh + rh - eaveY);
        const cx = eaveX / 2 + Math.sin(theta) * thick / 2, cy = (eaveY + wh + rh) / 2 + Math.cos(theta) * thick / 2;
        const slab = (side: 1 | -1): PrefabPart => ({ name: side === 1 ? "Roof R" : "Roof L", kind: "box", halfW: length / 2, halfH: thick / 2, halfD: d / 2 + overhang, position: [side * cx, cy, 0], roll: -side * theta, color: roof });
        return {
            footprint: Math.max(w, d) / 2 + 0.5,
            parts: [
                { name: "Walls", kind: "box", halfW: half, halfH: wh / 2, halfD: d / 2, position: [0, wh / 2, 0], color: wall, solid: true },
                slab(1), slab(-1),
                { name: "Gable front", kind: "plane", halfW: half, halfH: rh / 2, position: [0, wh + rh / 2, d / 2 + 0.01], color: wall, mask: "gable" },
                { name: "Gable back", kind: "plane", halfW: half, halfH: rh / 2, position: [0, wh + rh / 2, -d / 2 - 0.01], yaw: Math.PI, color: wall, mask: "gable" },
                { name: "Door", kind: "plane", halfW: 0.45, halfH: 1, position: [0, 1, d / 2 + 0.02], color: door },
            ],
        };
    },
};

const tree: PrefabInfo = {
    id: "tree", description: "Trunk cylinder and a round crown. 2 surfaces.",
    params: { height: "total height, 3.6", crownRadius: "1.3", trunkColor: "[104,74,48]", leafColor: "[64,132,72]" },
    build(p) {
        const h = num(p, "height", 3.6, 1, 15), crown = num(p, "crownRadius", 1.3, 0.3, 6);
        const trunkH = Math.max(0.5, h - crown * 1.4);
        return {
            footprint: crown,
            parts: [
                { name: "Trunk", kind: "cylinder", radius: Math.min(0.3, crown * 0.22), halfH: trunkH / 2, position: [0, trunkH / 2, 0], color: color(p, "trunkColor", [104, 74, 48]), solid: true },
                { name: "Crown", kind: "sphere", radius: crown, position: [0, trunkH + crown * 0.55, 0], color: color(p, "leafColor", [64, 132, 72]) },
            ],
        };
    },
};

const human: PrefabInfo = {
    id: "human", description: "Blocky person about 1.8 tall, facing +Z: legs, torso, head. 3 surfaces. Use it for the player and for NPCs.",
    params: { shirtColor: "[74,130,154]", pantsColor: "[57,69,95]", skinColor: "[236,196,160]", solid: "true; NPCs block the player, set false for a ghost" },
    build(p) {
        const solid = p.solid === undefined ? true : p.solid === true;
        return {
            footprint: 0.5,
            parts: [
                { name: "Legs", kind: "box", halfW: 0.22, halfH: 0.4, halfD: 0.14, position: [0, 0.4, 0], color: color(p, "pantsColor", [57, 69, 95]), solid },
                { name: "Torso", kind: "box", halfW: 0.3, halfH: 0.3, halfD: 0.17, position: [0, 1.1, 0], color: color(p, "shirtColor", [74, 130, 154]), solid },
                { name: "Head", kind: "sphere", radius: 0.21, position: [0, 1.6, 0], color: color(p, "skinColor", [236, 196, 160]) },
            ],
        };
    },
};

const pickup: PrefabInfo = {
    id: "pickup", description: "A small floating collectible (herb, gem, coin). 1 surface. Pair it with canvas_add_rule or canvas_add_collectible.",
    params: { shape: "sphere | box | coin, default sphere", size: "0.3", color: "[120,220,120]" },
    build(p) {
        const size = num(p, "size", 0.3, 0.1, 2), shape = p.shape ?? "sphere", c = color(p, "color", [120, 220, 120]);
        if (shape !== "sphere" && shape !== "box" && shape !== "coin") throw new Error("shape must be sphere, box or coin.");
        const y = size + 0.3;
        const part: PrefabPart = shape === "sphere" ? { name: "Item", kind: "sphere", radius: size, position: [0, y, 0], color: c }
            : shape === "box" ? { name: "Item", kind: "box", halfW: size * 0.8, halfH: size * 0.8, halfD: size * 0.8, position: [0, y, 0], yaw: 0.6, pitch: 0.4, color: c }
            : { name: "Item", kind: "cylinder", radius: size, halfH: size * 0.14, position: [0, y, 0], pitch: HALF_PI, color: c };
        return { footprint: size + 0.2, parts: [part] };
    },
};

const chest: PrefabInfo = {
    id: "chest", description: "Wooden chest: body and lid. 2 surfaces.",
    params: { bodyColor: "[128,84,46]", lidColor: "[150,100,56]" },
    build(p) {
        return {
            footprint: 0.7,
            parts: [
                { name: "Body", kind: "box", halfW: 0.6, halfH: 0.25, halfD: 0.4, position: [0, 0.25, 0], color: color(p, "bodyColor", [128, 84, 46]), solid: true },
                { name: "Lid", kind: "box", halfW: 0.62, halfH: 0.12, halfD: 0.42, position: [0, 0.62, 0], color: color(p, "lidColor", [150, 100, 56]), solid: true },
            ],
        };
    },
};

const rock: PrefabInfo = {
    id: "rock", description: "A squashed boulder. 1 surface.",
    params: { radius: "0.7", color: "[128,128,134]" },
    build(p) {
        const r = num(p, "radius", 0.7, 0.2, 5);
        return { footprint: r * 1.2, parts: [{ name: "Rock", kind: "sphere", radius: r, position: [0, r * 0.65, 0], scale: [1, 0.65, 1.15], color: color(p, "color", [128, 128, 134]), solid: true }] };
    },
};

const fence: PrefabInfo = {
    id: "fence", description: "A straight fence section along X (rotate with yaw). 1 surface.",
    params: { length: "3", height: "1", color: "[140,104,64]" },
    build(p) {
        const len = num(p, "length", 3, 0.5, 30), h = num(p, "height", 1, 0.3, 4);
        return { footprint: len / 2, parts: [{ name: "Fence", kind: "box", halfW: len / 2, halfH: h / 2, halfD: 0.06, position: [0, h / 2, 0], color: color(p, "color", [140, 104, 64]), solid: true }] };
    },
};

const gate: PrefabInfo = {
    id: "gate", description: "A barrier with two posts, for a path that opens when a quest is done (hide the group). 3 surfaces.",
    params: { width: "3", height: "1.8", color: "[150,110,70]", postColor: "[96,70,44]" },
    build(p) {
        const w = num(p, "width", 3, 1, 12), h = num(p, "height", 1.8, 0.8, 5);
        return {
            footprint: w / 2 + 0.3,
            parts: [
                { name: "Barrier", kind: "box", halfW: w / 2, halfH: h / 2 - 0.1, halfD: 0.1, position: [0, h / 2 - 0.1, 0], color: color(p, "color", [150, 110, 70]), solid: true },
                { name: "Post L", kind: "cylinder", radius: 0.14, halfH: h / 2 + 0.2, position: [-w / 2 - 0.14, h / 2 + 0.2, 0], color: color(p, "postColor", [96, 70, 44]), solid: true },
                { name: "Post R", kind: "cylinder", radius: 0.14, halfH: h / 2 + 0.2, position: [w / 2 + 0.14, h / 2 + 0.2, 0], color: color(p, "postColor", [96, 70, 44]), solid: true },
            ],
        };
    },
};

const lamppost: PrefabInfo = {
    id: "lamppost", description: "Pole and a glowing lamp head (a colour, not a light: use canvas_set_lighting lamps for real light). 2 surfaces.",
    params: { height: "3", lampColor: "[255,220,140]" },
    build(p) {
        const h = num(p, "height", 3, 1.5, 8);
        return {
            footprint: 0.4,
            parts: [
                { name: "Pole", kind: "cylinder", radius: 0.08, halfH: h / 2, position: [0, h / 2, 0], color: [52, 56, 66], solid: true },
                { name: "Lamp", kind: "sphere", radius: 0.22, position: [0, h + 0.1, 0], color: color(p, "lampColor", [255, 220, 140]) },
            ],
        };
    },
};

const signpost: PrefabInfo = {
    id: "signpost", description: "A post with a board to paint text on; the board faces +Z. 2 surfaces.",
    params: { boardColor: "[176,138,88]" },
    build(p) {
        return {
            footprint: 0.7,
            parts: [
                { name: "Post", kind: "box", halfW: 0.06, halfH: 0.65, halfD: 0.06, position: [0, 0.65, 0], color: [96, 70, 44], solid: true },
                { name: "Board", kind: "box", halfW: 0.55, halfH: 0.28, halfD: 0.04, position: [0, 1.3, 0.08], color: color(p, "boardColor", [176, 138, 88]) },
            ],
        };
    },
};

const ground: PrefabInfo = {
    id: "ground", description: "A flat patch facing up: the base ground, a path or a plaza. 1 surface. Use lift to stack paths above the ground.",
    params: { width: "x size, 20", depth: "z size, 20", color: "[104,150,86]", lift: "height above y=0, 0" },
    build(p) {
        const w = num(p, "width", 20, 0.5, 200), d = num(p, "depth", 20, 0.5, 200), lift = num(p, "lift", 0, 0, 5);
        return { footprint: Math.max(w, d) / 2, parts: [{ name: "Ground", kind: "plane", halfW: w / 2, halfH: d / 2, position: [0, lift, 0], pitch: -HALF_PI, color: color(p, "color", [104, 150, 86]) }] };
    },
};

const pond: PrefabInfo = {
    id: "pond", description: "A flat round pool the player cannot walk through. 1 surface.",
    params: { radius: "2.5", color: "[70,132,190]" },
    build(p) {
        const r = num(p, "radius", 2.5, 0.5, 30);
        return { footprint: r, parts: [{ name: "Water", kind: "cylinder", radius: r, halfH: 0.04, position: [0, 0.04, 0], color: color(p, "color", [70, 132, 190]), solid: true }] };
    },
};

export const PREFABS: Record<string, PrefabInfo> = Object.fromEntries([house, tree, human, pickup, chest, rock, fence, gate, lamppost, signpost, ground, pond].map(p => [p.id, p]));
export const PREFAB_IDS = Object.keys(PREFABS);

/** Parts and footprint for a prefab id, throwing a message that lists the valid ids. */
export function buildPrefab(id: string, params: Record<string, unknown> = {}): ReturnType<PrefabInfo["build"]> {
    const prefab = PREFABS[id];
    if (!prefab) throw new Error(`Unknown prefab "${id}". Available: ${PREFAB_IDS.join(", ")}.`);
    return prefab.build(params);
}
