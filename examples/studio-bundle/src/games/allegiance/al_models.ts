// Allegiance's equipment, the speaker's podium and party flag, and tracer rounds.
// People themselves come from Mesha via al_people.ts.
//
// Model space: +X right, +Y up, -Z forward (qp_math.ts frameMatrix), feet on y = 0.

import { MeshBuilder, buildSky, type ModelMesh } from "../../apps/quadplanet/qp_models";
import { MATERIAL_GLOW, MATERIAL_PAINT } from "../../apps/quadplanet/qp_shader";
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
