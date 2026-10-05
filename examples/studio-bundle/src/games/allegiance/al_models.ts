// Allegiance's equipment, the speaker's podium and party flag, and tracer rounds.
// People themselves come from Mesha via al_people.ts.
//
// Model space: +X right, +Y up, -Z forward (qp_math.ts frameMatrix), feet on y = 0.

import { MeshBuilder, buildSky, type ModelMesh } from "../../apps/quadplanet/qp_models";
import { MATERIAL_GLOW, MATERIAL_HOUSE, MATERIAL_PAINT, SURFACE } from "../../apps/quadplanet/qp_shader";
import { MAT_BODY, MAT_CLOTH_TOP } from "./al_shader";

type RGB = [number, number, number];

const WHITE: RGB = [1, 1, 1];
const GUN: RGB = [0.12, 0.12, 0.13];

export interface PersonLook {
    skin: RGB;
    hair: RGB;
    hat: boolean;
    female: boolean;
    /** "none", "pistol", "rifle" or "rail": what the right hand holds. */
    weapon: string;
    /** Soldiers wear helmets and webbing. */
    soldier: boolean;
    /** Speakers (you, rival orators) get a sash. */
    sash: boolean;
}

/** Limb codes, carried in uv.y. */
const RIGID = 0, RIGHT_ARM = 4;

class PersonBuilder {
    m = new MeshBuilder();
    private mark = 0;
    /** Adds a part and tags its vertices with `limb`. */
    part(limb: number, add: (m: MeshBuilder) => void): this {
        this.mark = this.m.vertexData.length / 12;
        add(this.m);
        const end = this.m.vertexData.length / 12;
        for (let v = this.mark; v < end; v++) this.m.vertexData[v * 12 + 7] = limb + 0.49;
        return this;
    }
}

/** Equipment only. The body, face, hair, clothes and shoes come from Mesha's human. */
export function buildEquipment(l: PersonLook): ModelMesh {
    const b = new PersonBuilder();
    const seg = 12, ring = 8;
    b.part(RIGID, m => {
        if (l.soldier) {
            m.ellipsoid([0, 1.7, 0.005], [0.13, 0.085, 0.14], [0.2, 0.24, 0.18], MAT_BODY, seg, ring);
            m.box([0, 1.25, -0.11], [0.17, 0.16, 0.035], [0.16, 0.18, 0.13], MAT_BODY);
        } else {
            if (l.hat) {
                m.ellipsoid([0, 1.735, 0.005], [0.118, 0.07, 0.125], [0.18, 0.15, 0.13], MAT_BODY, seg, ring);
                m.box([0, 1.71, -0.13], [0.1, 0.008, 0.055], [0.18, 0.15, 0.13], MAT_BODY);
            }
        }
        if (l.sash) m.hexa([
            [-0.2, 1.38, -0.135], [0.0, 1.0, -0.135], [0.08, 1.04, -0.135], [-0.12, 1.42, -0.135],
            [-0.2, 1.38, -0.1], [0.0, 1.0, -0.1], [0.08, 1.04, -0.1], [-0.12, 1.42, -0.1],
        ], [0.95, 0.85, 0.2], MATERIAL_PAINT);
    });
    b.part(RIGHT_ARM, m => {
        if (l.weapon !== "none") {
            // Held along the forearm: hangs at the side walking, points ahead when aiming.
            if (l.weapon === "pistol") m.box([0.265, 0.86, -0.06], [0.022, 0.07, 0.05], GUN, MAT_BODY);
            else {
                const long = l.weapon === "rail" ? 0.42 : 0.36;
                const color: RGB = l.weapon === "rail" ? [0.25, 0.6, 0.85] : GUN;
                m.box([0.265, 0.92 - long * 0.55, -0.05], [0.028, long, 0.045], color, MAT_BODY);
                m.box([0.265, 0.82, -0.12], [0.02, 0.05, 0.03], GUN, MAT_BODY);
            }
        }
    });
    return b.m.build();
}

/** The speaker's podium (about 1.1 m tall), with a front panel in the party color (cloth tint). */
export function buildPodium(): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 0.08, 0], [0.75, 0.08, 0.55], [0.25, 0.2, 0.16], MATERIAL_PAINT);
    m.hexa([
        [-0.38, 0.16, -0.26], [0.38, 0.16, -0.26], [0.38, 0.16, 0.22], [-0.38, 0.16, 0.22],
        [-0.42, 1.08, -0.32], [0.42, 1.08, -0.32], [0.42, 1.12, 0.22], [-0.42, 1.12, 0.22],
    ], [0.3, 0.24, 0.19], MATERIAL_PAINT);
    m.hexa([
        [-0.33, 0.25, -0.3], [0.33, 0.25, -0.3], [0.33, 0.25, -0.27], [-0.33, 0.25, -0.27],
        [-0.36, 1.0, -0.355], [0.36, 1.0, -0.355], [0.36, 1.0, -0.325], [-0.36, 1.0, -0.325],
    ], WHITE, MAT_CLOTH_TOP);
    // Microphone.
    m.box([0, 1.2, -0.12], [0.012, 0.09, 0.012], GUN, MATERIAL_PAINT);
    m.ellipsoid([0, 1.3, -0.14], [0.025, 0.03, 0.025], [0.2, 0.2, 0.2], MATERIAL_PAINT, 8, 6);
    return m.build();
}

/** A flagpole with a banner in the party color (cloth tint), ~6 m tall. */
export function buildFlag(): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 3, 0], [0.04, 3, 0.04], [0.75, 0.75, 0.78], MATERIAL_PAINT);
    m.ellipsoid([0, 6.05, 0], [0.07, 0.07, 0.07], [0.9, 0.75, 0.25], MATERIAL_PAINT, 8, 6);
    m.box([0.95, 5.3, 0], [0.9, 0.6, 0.015], WHITE, MAT_CLOTH_TOP);
    // A pale emblem disc in the middle of the banner.
    m.cylinderZ(0.95, 5.3, -0.02, 0.02, 0.28, [0.95, 0.92, 0.85], MATERIAL_PAINT, 16);
    return m.build();
}

/** A unit tracer along -Z (scaled to the shot's length by its matrix). */
export function buildTracer(color: RGB): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 0, -0.5], [0.5, 0.5, 0.5], color, MATERIAL_GLOW);
    return m.build();
}

/** A ring marker on the ground (where to stand, objectives): flat glowing segments. */
export function buildRing(radius: number, color: RGB): ModelMesh {
    const m = new MeshBuilder();
    const n = 24;
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
        m.box([x, 0.03, z], [0.12, 0.02, 0.12], color, MATERIAL_GLOW);
    }
    return m.build();
}

export { buildSky, type ModelMesh };

/** A cabin-sized electric multicopter with four large horizontal rotors. */
export function buildFlyingCar(): ModelMesh {
    const m = new MeshBuilder();
    m.ellipsoid([0, 0.35, 0], [1, 0.55, 1.8], [0.62, 0.66, 0.72], MATERIAL_PAINT, 12, 6);
    m.ellipsoid([0, 0.7, -0.4], [0.85, 0.45, 1.1], [0.12, 0.32, 0.44], MATERIAL_PAINT, 12, 6);
    for (const x of [-1.8, 1.8]) for (const z of [-1.5, 1.5]) {
        m.box([x / 2, 0.1, z / 2], [Math.abs(x) / 2, 0.09, 0.1], [0.22, 0.24, 0.27], MATERIAL_PAINT);
        m.ellipsoid([x, 0.15, z], [0.95, 0.07, 0.95], [0.18, 0.2, 0.23], MATERIAL_PAINT, 16, 4);
        m.ellipsoid([x, 0.24, z], [0.82, 0.015, 0.82], [0.45, 0.56, 0.61], MATERIAL_PAINT, 16, 4);
        m.box([x, -0.04, z], [0.16, 0.04, 0.16], [0.15, 0.75, 0.95], MATERIAL_GLOW);
    }
    return m.build();
}

// --- Low-poly set dressing -----------------------------------------------------------------------
// Simple stand-ins (a few dozen boxes each) that can be swapped for detailed meshes later; all
// are drawn instanced (al_scatter.ts). Paint takes the instance tint; MAT_CLOTH_TOP takes it too
// (flags, awnings) in the instanced shader.

const CONCRETE: RGB = [0.62, 0.6, 0.56];
const OLIVE: RGB = [0.36, 0.4, 0.3];
const STEEL: RGB = [0.45, 0.47, 0.5];
const WOOD: RGB = [0.45, 0.32, 0.2];

export function buildBench(): ModelMesh {
    const m = new MeshBuilder();
    for (const x of [-0.75, 0.75]) m.box([x, 0.22, 0], [0.04, 0.22, 0.22], GUN, MATERIAL_PAINT);
    for (const z of [-0.12, 0, 0.12]) m.box([0, 0.45, z], [0.9, 0.025, 0.05], WOOD, MATERIAL_PAINT);
    for (const y of [0.62, 0.78]) m.box([0, y, 0.2], [0.9, 0.05, 0.02], WOOD, MATERIAL_PAINT);
    return m.build();
}

export function buildStreetLamp(): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 0.15, 0], [0.16, 0.15, 0.16], STEEL, MATERIAL_PAINT);
    m.box([0, 2.6, 0], [0.05, 2.5, 0.05], STEEL, MATERIAL_PAINT);
    m.box([0, 5.05, -0.45], [0.05, 0.05, 0.5], STEEL, MATERIAL_PAINT);
    m.box([0, 4.95, -0.85], [0.18, 0.06, 0.12], [1, 0.92, 0.7], MATERIAL_GLOW);
    return m.build();
}

export function buildTrashBin(): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 0.45, 0], [0.28, 0.45, 0.28], [0.22, 0.35, 0.28], MATERIAL_PAINT);
    m.box([0, 0.93, 0], [0.31, 0.04, 0.31], [0.18, 0.28, 0.22], MATERIAL_PAINT);
    return m.build();
}

export function buildBarrier(): ModelMesh {
    const m = new MeshBuilder();
    m.hexa([[-1, 0, -0.3], [1, 0, -0.3], [1, 0, 0.3], [-1, 0, 0.3], [-1, 0.8, -0.1], [1, 0.8, -0.1], [1, 0.8, 0.1], [-1, 0.8, 0.1]], CONCRETE, MATERIAL_PAINT);
    m.box([0, 0.55, -0.205], [0.95, 0.06, 0.01], [0.95, 0.6, 0.1], MATERIAL_PAINT);
    return m.build();
}

export function buildCrates(): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 0.4, 0], [0.4, 0.4, 0.4], WOOD, MATERIAL_PAINT);
    m.box([0.85, 0.35, 0.1], [0.35, 0.35, 0.35], [0.5, 0.38, 0.24], MATERIAL_PAINT);
    m.box([0.3, 1.1, 0.05], [0.3, 0.3, 0.3], [0.42, 0.3, 0.18], MATERIAL_PAINT);
    return m.build();
}

export function buildSandbags(): ModelMesh {
    const m = new MeshBuilder();
    for (let row = 0; row < 3; row++) for (let i = 0; i < 5 - row; i++)
        m.ellipsoid([(i - (4 - row) / 2) * 0.55, 0.14 + row * 0.24, 0], [0.3, 0.14, 0.22], [0.6, 0.55, 0.4], MATERIAL_PAINT, 8, 4);
    return m.build();
}

/** A shop's street kiosk: counter and an awning in the shop's color (instance tint). */
export function buildKiosk(): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 0.55, 0], [1.1, 0.55, 0.35], [0.85, 0.82, 0.75], MATERIAL_PAINT);
    for (const x of [-1.05, 1.05]) m.box([x, 1.4, 0.2], [0.04, 1.4, 0.04], STEEL, MATERIAL_PAINT);
    m.hexa([[-1.25, 2.6, -0.5], [1.25, 2.6, -0.5], [1.25, 2.6, 0.45], [-1.25, 2.6, 0.45], [-1.25, 2.75, -0.5], [1.25, 2.75, -0.5], [1.25, 3.0, 0.45], [-1.25, 3.0, 0.45]], WHITE, MAT_CLOTH_TOP);
    m.box([0, 3.35, 0.3], [0.9, 0.3, 0.03], [0.1, 0.1, 0.1], MATERIAL_PAINT);
    m.box([0, 3.35, 0.27], [0.8, 0.2, 0.01], WHITE, MAT_CLOTH_TOP);
    return m.build();
}

/** A supply cache left in a house: a footlocker with a glowing latch. */
export function buildLootCrate(): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, 0.22, 0], [0.42, 0.22, 0.26], OLIVE, MATERIAL_PAINT);
    m.box([0, 0.46, 0], [0.44, 0.03, 0.28], [0.28, 0.3, 0.22], MATERIAL_PAINT);
    m.box([0, 0.3, -0.27], [0.08, 0.06, 0.01], [1, 0.8, 0.3], MATERIAL_GLOW);
    return m.build();
}

/** A vertical light beam (glow), 1 m wide and `height` tall: party headquarters seen from the sky. */
export function buildBeacon(height = 300): ModelMesh {
    const m = new MeshBuilder();
    m.box([0, height / 2, 0], [0.6, height / 2, 0.6], WHITE, MATERIAL_GLOW);
    return m.build();
}

/** Military buildings at their nominal sizes (al_military.ts SIZES): low, hard, olive. */
export function buildMilitary(kind: "hq" | "barracks" | "depot" | "hangar" | "tower" | "wall"): ModelMesh {
    const m = new MeshBuilder();
    const slab = (w: number, d: number, h: number, color: RGB) => {
        m.box([0, h / 2, 0], [w / 2, h / 2, d / 2], color, MATERIAL_PAINT);
        m.box([0, h + 0.15, 0], [w / 2 + 0.25, 0.15, d / 2 + 0.25], [0.3, 0.31, 0.28], MATERIAL_PAINT);
    };
    const door = (w: number, d: number, dw: number, dh: number) => m.box([0, dh / 2, -d / 2 - 0.03], [dw / 2, dh / 2, 0.04], [0.18, 0.2, 0.17], MATERIAL_PAINT);
    const windows = (w: number, d: number, y: number) => {
        for (let x = -w / 2 + 1.5; x <= w / 2 - 1.5; x += 2.5) m.box([x, y, -d / 2 - 0.03], [0.5, 0.25, 0.03], [0.15, 0.25, 0.3], MATERIAL_PAINT);
    };
    switch (kind) {
        case "hq": slab(14, 10, 7, CONCRETE); door(14, 10, 2.4, 2.6); windows(14, 10, 4.8);
            m.box([4, 7.8, 2], [0.1, 1.5, 0.1], STEEL, MATERIAL_PAINT); m.ellipsoid([4, 9.4, 2], [0.6, 0.15, 0.6], STEEL, MATERIAL_PAINT, 10, 4); break;
        case "barracks": slab(18, 7, 4.5, OLIVE); door(18, 7, 1.4, 2.2); windows(18, 7, 2.6); break;
        case "depot": slab(11, 11, 5.5, [0.5, 0.48, 0.42]); door(11, 11, 4, 4); break;
        case "hangar": {
            // A quonset: half-cylinder roof.
            for (let i = 0; i < 10; i++) {
                const a0 = i / 10 * Math.PI, a1 = (i + 1) / 10 * Math.PI, r = 7;
                m.hexa([[Math.cos(a0) * r, Math.sin(a0) * 6.5, -7], [Math.cos(a1) * r, Math.sin(a1) * 6.5, -7], [Math.cos(a1) * r, Math.sin(a1) * 6.5, 7], [Math.cos(a0) * r, Math.sin(a0) * 6.5, 7],
                    [Math.cos(a0) * (r - 0.2), Math.sin(a0) * 6.3, -7], [Math.cos(a1) * (r - 0.2), Math.sin(a1) * 6.3, -7], [Math.cos(a1) * (r - 0.2), Math.sin(a1) * 6.3, 7], [Math.cos(a0) * (r - 0.2), Math.sin(a0) * 6.3, 7]], OLIVE, MATERIAL_PAINT);
            }
            m.box([0, 2.5, -7.02], [4.5, 2.5, 0.05], [0.22, 0.24, 0.2], MATERIAL_PAINT);
            break;
        }
        case "tower":
            for (const x of [-1.2, 1.2]) for (const z of [-1.2, 1.2]) m.box([x, 3.5, z], [0.12, 3.5, 0.12], STEEL, MATERIAL_PAINT);
            m.box([0, 7.1, 0], [1.6, 0.1, 1.6], WOOD, MATERIAL_PAINT);
            m.box([0, 7.7, -1.55], [1.6, 0.5, 0.05], OLIVE, MATERIAL_PAINT);
            m.box([0, 7.7, 1.55], [1.6, 0.5, 0.05], OLIVE, MATERIAL_PAINT);
            m.box([-1.55, 7.7, 0], [0.05, 0.5, 1.6], OLIVE, MATERIAL_PAINT);
            m.box([1.55, 7.7, 0], [0.05, 0.5, 1.6], OLIVE, MATERIAL_PAINT);
            m.box([0, 9.1, 0], [1.8, 0.08, 1.8], [0.3, 0.31, 0.28], MATERIAL_PAINT);
            m.box([0, 8.6, -1.3], [0.12, 0.08, 0.12], [1, 0.95, 0.75], MATERIAL_GLOW);
            break;
        case "wall":
            // One meter of wall along x (scaled to the segment's length), with a coping.
            // The wall is fieldstone (a city surface, al_materials.ts): its surface kind rides in uv.y.
            {
                const first = m.vertexData.length / 12;
                m.box([0, 1.3, 0], [0.5, 1.3, 0.3], CONCRETE, MATERIAL_HOUSE);
                for (let v = first; v < m.vertexData.length / 12; v++) m.vertexData[v * 12 + 7] = SURFACE.fieldstone + 0.5;
            }
            m.box([0, 2.65, 0], [0.5, 0.05, 0.36], [0.5, 0.49, 0.46], MATERIAL_PAINT);
            break;
    }
    return m.build();
}

/** First-person view model: the weapon in your hands, in camera space (+x right, +y up, -z ahead),
 * low and to the right of the crosshair. */
export function buildViewWeapon(kind: string): ModelMesh {
    const m = new MeshBuilder();
    const skin: RGB = [0.85, 0.66, 0.5];
    const x = 0.24, y = -0.24;
    if (kind === "none") {
        m.ellipsoid([x, y, -0.7], [0.05, 0.045, 0.07], skin, MATERIAL_PAINT, 8, 6);
        m.ellipsoid([-x, y, -0.7], [0.05, 0.045, 0.07], skin, MATERIAL_PAINT, 8, 6);
        return m.build();
    }
    const long = kind === "pistol" ? 0.17 : kind === "rail" ? 0.6 : 0.5;
    const front = -0.62 - long;
    const color: RGB = kind === "rail" ? [0.25, 0.6, 0.85] : [0.2, 0.2, 0.22];
    // Barrel and receiver, then the grip, a stock for long guns, and the hands.
    m.box([x, y, (front - 0.62) / 2], [0.022, 0.03, long / 2], color, MATERIAL_PAINT);
    m.box([x, y + 0.035, -0.66 - long * 0.3], [0.012, 0.008, long * 0.25], [0.1, 0.1, 0.11], MATERIAL_PAINT);
    m.box([x, y - 0.06, -0.66], [0.018, 0.045, 0.022], [0.12, 0.12, 0.13], MATERIAL_PAINT);
    if (kind !== "pistol") m.box([x, y - 0.01, -0.5], [0.025, 0.035, 0.12], [0.12, 0.12, 0.13], MATERIAL_PAINT);
    if (kind === "rail") m.box([x, y + 0.04, -0.62 - long * 0.5], [0.01, 0.01, long * 0.4], [0.4, 0.85, 1], MATERIAL_GLOW);
    // Iron sights, lined up on the crosshair when you aim down them: a notched rear sight and a
    // front post with a glowing dot.
    const rail = y + 0.038, rearZ = -0.66 - long * 0.05, frontZ = front + 0.025;
    for (const s of [-1, 1]) m.box([x + s * 0.005, rail + 0.008, rearZ], [0.0025, 0.006, 0.004], GUN, MATERIAL_PAINT);
    m.box([x, rail + 0.002, rearZ], [0.0075, 0.002, 0.004], GUN, MATERIAL_PAINT);
    m.box([x, rail + 0.009, frontZ], [0.0015, 0.009, 0.0025], GUN, MATERIAL_PAINT);
    m.box([x, rail + 0.019, frontZ], [0.0016, 0.0016, 0.0016], [1, 0.75, 0.2], MATERIAL_GLOW);
    m.ellipsoid([x, y - 0.075, -0.64], [0.035, 0.04, 0.045], skin, MATERIAL_PAINT, 8, 6);
    if (kind !== "pistol") m.ellipsoid([x - 0.02, y - 0.03, -0.62 - long * 0.6], [0.035, 0.035, 0.045], skin, MATERIAL_PAINT, 8, 6);
    return m.build();
}
