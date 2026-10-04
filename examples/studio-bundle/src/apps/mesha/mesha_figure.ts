// Mesha's human figure: a posable skeleton dressed in an anatomical implicit surface. Every form a
// figure artist blocks in - cranium, jaw, cheekbones, brow, the lids around each eyeball, nose, lips,
// ears, the neck's cords, rib cage, pectorals or breasts, shoulder blades, belly, pelvis, glutes, the
// deltoid, biceps and forearm masses, palms and three-jointed fingers, thigh, knee, calf, ankle and
// foot - is a primitive attached to a bone and smoothly blended with its neighbours (fingers only to
// their palm, so they never fuse into mittens). Posing moves the primitives with their bones before
// the surface is meshed, so an elbow bends as a real joint rather than as a skinned mesh's kink.
//
// The figure faces +Z with its left side toward +X and stands on y = 0. Measurements follow adult
// anthropometric ratios (a 1.75 m figure is about 7.6 heads tall) blended between typical female and
// male proportions by `masculinity`, then shaped by weight, muscle and a dozen face controls.
//
// `buildFigure` returns the skin (regions skin, lips, nails), the eyes (sclera, iris, pupil, cornea)
// and a FigureHandle that clothing and hair use: the body's field for collisions, the posed skeleton
// and the head frame.

import { type Mesh, type Vec3, type Part, newPart, vertex, tri } from "./mesha_mesh";
import {
    type SdfNode, type Field, type Rot, type DetailRegion, type Box,
    SPEC, sphere, ellipsoid, roundCone, capsule, union, subtract, meshField, fieldOf, custom, LazyGrid,
} from "./mesha_sdf";
import { hash01 } from "./mesha_noise";

// --- 3x3 rotations (row-major, world = M v) ---------------------------------------------------------

export type M3 = number[];
export const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function m3mul(a: M3, b: M3): M3 {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
}
export function m3apply(m: M3, v: Vec3): Vec3 {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
export function m3transpose(m: M3): M3 { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
/** Rotation by `deg` degrees about an axis. */
export function m3axis(axis: Vec3, deg: number): M3 {
    const l = Math.hypot(...axis) || 1, x = axis[0] / l, y = axis[1] / l, z = axis[2] / l;
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
/** X, then Y, then Z (degrees), about the world axes. */
export function m3euler(x: number, y: number, z: number): M3 {
    return m3mul(m3axis([0, 0, 1], z), m3mul(m3axis([0, 1, 0], y), m3axis([1, 0, 0], x)));
}
/** A world rotation as mesha_sdf's Rot (local axes in rows). */
const toRot = (m: M3): Rot => m3transpose(m) as Rot;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// --- Parameters ----------------------------------------------------------------------------------

export const POSES = ["relaxed", "apose", "tpose", "contrapposto", "walking", "hipsHands", "wave"] as const;
export type PoseName = typeof POSES[number];

export interface FigureParams {
    height: number;
    /** 0 typical female proportions, 1 typical male. */
    masculinity: number;
    /** Body fat 0 (lean) to 1 (heavy). */
    weight: number;
    muscle: number;
    shoulders: number;
    hips: number;
    waist: number;
    bust: number;
    legLength: number;
    armLength: number;
    headSize: number;
    neckLength: number;
    // Face (each 0..1, 0.5 average)
    jawWidth: number;
    chin: number;
    cheekbones: number;
    noseLength: number;
    noseWidth: number;
    noseBridge: number;
    lips: number;
    mouthWidth: number;
    eyeSize: number;
    eyeSpacing: number;
    browRidge: number;
    earSize: number;
    smile: number;
    /** Individual asymmetry and small differences. */
    seed: number;
    // Pose
    pose: PoseName;
    armRaise: number;
    elbowBend: number;
    headTurn: number;
    headTilt: number;
    fingerCurl: number;
    stance: number;
    /** Heel height the feet stand on (shoes lift the heel and point the foot). */
    heel: number;
    /** Toes shaped (barefoot) or a smooth foot for footwear. */
    toes: boolean;
    /** Extra lift (m) for the soles of shoes the feet will stand in. */
    sole: number;
    /** Mesh detail multiplier: 1 normal, below 1 finer. */
    detail: number;
}

export const DEFAULT_FIGURE: FigureParams = {
    height: 1.7, masculinity: 0.1, weight: 0.35, muscle: 0.35, shoulders: 1, hips: 1, waist: 1, bust: 0.5, legLength: 1, armLength: 1, headSize: 1, neckLength: 1,
    jawWidth: 0.5, chin: 0.5, cheekbones: 0.5, noseLength: 0.5, noseWidth: 0.5, noseBridge: 0.5, lips: 0.5, mouthWidth: 0.5, eyeSize: 0.5, eyeSpacing: 0.5, browRidge: 0.5, earSize: 0.5, smile: 0.15, seed: 1,
    pose: "relaxed", armRaise: 0, elbowBend: 0, headTurn: 0, headTilt: 0, fingerCurl: 0.35, stance: 0.5, heel: 0, toes: true, sole: 0, detail: 1,
};

// --- Skeleton ------------------------------------------------------------------------------------

export type BoneName =
    | "pelvis" | "spine" | "chest" | "neck" | "head"
    | "clavicleL" | "upperarmL" | "forearmL" | "handL" | "clavicleR" | "upperarmR" | "forearmR" | "handR"
    | "thighL" | "shinL" | "footL" | "toesL" | "thighR" | "shinR" | "footR" | "toesR"
    | `finger${"L" | "R"}${0 | 1 | 2 | 3 | 4}${0 | 1 | 2}`;

export interface Bone {
    name: BoneName;
    parent: BoneName | null;
    /** Rest-pose joint position. */
    head: Vec3;
    tail: Vec3;
    /** Posed: world rotation since rest, and the posed joint. */
    R: M3;
    posedHead: Vec3;
}

export interface Skeleton {
    bones: Map<BoneName, Bone>;
    /** A rest-space point carried by `bone` into the pose. */
    pt(bone: BoneName, p: Vec3): Vec3;
    /** A rest-space rotation carried by `bone` into the pose. */
    rot(bone: BoneName, m?: M3): M3;
}

/** Everything about a figure's proportions that the surface and the skeleton share (reference units). */
export interface Measures {
    s: number; // overall scale from reference units to meters
    m: number; fat: number; mus: number;
    ankleY: number; kneeY: number; hipY: number; crotchY: number; waistY: number; navelY: number; chestY: number; shoulderY: number; neckY: number; chinY: number; topY: number;
    eyeY: number; headH: number; hu: number; // head unit (1 at a 0.228 m head)
    hipX: number; shoulderX: number; kneeX: number; ankleX: number;
    upperArm: number; foreArm: number; handLen: number;
    footLen: number; heelBack: number;
}

export function measures(p: FigureParams): Measures {
    const m = clamp(p.masculinity, 0, 1), fat = clamp(p.weight, 0, 1), mus = clamp(p.muscle, 0, 1);
    const mf = (f: number, mm: number) => lerp(f, mm, m);
    const legF = p.legLength, headH = 0.228 * p.headSize * mf(0.97, 1);
    // Reference (1.75 m) heights, legs scaled about the floor, torso stacked on top.
    const ankleY = 0.078;
    const kneeY = ankleY + (0.49 - ankleY) * legF;
    const hipY = ankleY + (0.915 - ankleY) * legF;
    const torso = mf(0.6, 0.615);
    const waistY = hipY + mf(0.165, 0.15), navelY = hipY + 0.125, chestY = hipY + 0.355, shoulderY = hipY + mf(0.505, 0.515), neckY = hipY + mf(0.525, 0.535);
    const chinY = hipY + torso + (p.neckLength - 1) * 0.04;
    const topY = chinY + headH;
    const s = p.height / topY;
    const hu = headH / 0.228;
    return {
        s, m, fat, mus,
        ankleY, kneeY, hipY, crotchY: hipY - 0.085, waistY, navelY, chestY, shoulderY, neckY, chinY, topY,
        eyeY: chinY + headH * 0.49, headH, hu,
        hipX: mf(0.09, 0.085) * lerp(0.92, 1.1, (p.hips - 0.8) / 0.4),
        shoulderX: mf(0.158, 0.178) * lerp(0.9, 1.1, (p.shoulders - 0.8) / 0.4),
        kneeX: mf(0.082, 0.088), ankleX: mf(0.085, 0.092) + (p.stance - 0.5) * 0.12,
        upperArm: mf(0.29, 0.305) * p.armLength, foreArm: mf(0.235, 0.25) * p.armLength, handLen: mf(0.172, 0.19) * p.armLength,
        footLen: mf(0.235, 0.262), heelBack: mf(0.05, 0.056),
    };
}

/** Joint rotations (left side; the right mirrors) for each named pose, in degrees. */
interface PoseSpec {
    shoulder: [number, number, number]; // abduct, flex forward, twist
    elbow: number; forearmTwist: number;
    wrist: [number, number];
    shoulderR?: [number, number, number]; elbowR?: number; wristR?: [number, number];
    hipL: [number, number, number]; hipR: [number, number, number]; // flex forward, abduct, twist
    kneeL: number; kneeR: number;
    ankleL: number; ankleR: number;
    pelvis: [number, number, number]; spine: [number, number, number]; chest: [number, number, number];
    neck: [number, number, number]; head: [number, number, number];
    /** Extra finger curl. */
    curl?: number;
}

const POSE_SPECS: Record<PoseName, PoseSpec> = {
    relaxed: { shoulder: [8, 4, 0], elbow: 12, forearmTwist: 0, wrist: [6, 0], hipL: [0, 1.5, 0], hipR: [0, 1.5, 0], kneeL: 2, kneeR: 2, ankleL: 0, ankleR: 0, pelvis: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0] },
    apose: { shoulder: [38, 0, 0], elbow: 4, forearmTwist: 0, wrist: [0, 0], hipL: [0, 4, 0], hipR: [0, 4, 0], kneeL: 0, kneeR: 0, ankleL: 0, ankleR: 0, pelvis: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], curl: -0.25 },
    tpose: { shoulder: [88, 0, 0], elbow: 0, forearmTwist: 0, wrist: [0, 0], hipL: [0, 3, 0], hipR: [0, 3, 0], kneeL: 0, kneeR: 0, ankleL: 0, ankleR: 0, pelvis: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], curl: -0.3 },
    contrapposto: { shoulder: [10, 2, 0], elbow: 18, forearmTwist: 0, wrist: [8, 0], shoulderR: [6, 8, 0], elbowR: 8, hipL: [-2, 4, -6], hipR: [4, -1, 4], kneeL: 0, kneeR: 16, ankleL: 0, ankleR: 8, pelvis: [0, 6, -5], spine: [0, -3, 3], chest: [0, -4, 4], neck: [0, 0, -1], head: [0, -8, 0] },
    walking: { shoulder: [7, -22, 0], elbow: 25, forearmTwist: 0, wrist: [5, 0], shoulderR: [7, 24, 0], elbowR: 14, hipL: [24, 2, 0], hipR: [-14, 2, 0], kneeL: 8, kneeR: 22, ankleL: -6, ankleR: 12, pelvis: [0, 7, 0], spine: [3, -5, 0], chest: [0, -6, 0], neck: [0, 4, 0], head: [-3, 5, 0] },
    hipsHands: { shoulder: [36, -16, -10], elbow: 108, forearmTwist: -40, wrist: [-14, 0], hipL: [0, 4, -4], hipR: [0, 4, -4], kneeL: 0, kneeR: 6, ankleL: 0, ankleR: 2, pelvis: [0, 0, 0], spine: [0, 0, 0], chest: [-2, 0, 0], neck: [0, 0, 0], head: [-3, 0, 0], curl: 0.15 },
    wave: { shoulder: [12, 4, 0], elbow: 14, forearmTwist: 0, wrist: [6, 0], shoulderR: [150, -16, 30], elbowR: 32, wristR: [-8, 0], hipL: [0, 2, 0], hipR: [0, 2, 0], kneeL: 2, kneeR: 2, ankleL: 0, ankleR: 0, pelvis: [0, 0, 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, -3], head: [0, -6, -6], curl: -0.2 },
};

/** Mirrors a left-side rotation across the X plane. */
const mirrorM = (m: M3): M3 => [m[0], -m[1], -m[2], -m[3], m[4], m[5], -m[6], m[7], m[8]];

export function buildSkeleton(p: FigureParams, M: Measures): Skeleton {
    const bones = new Map<BoneName, Bone>();
    const bone = (name: BoneName, parent: BoneName | null, head: Vec3, tail: Vec3) => bones.set(name, { name, parent, head, tail, R: I3, posedHead: head });
    const { m } = M;
    const mf = (f: number, mm: number) => lerp(f, mm, m);
    // Torso.
    bone("pelvis", null, [0, M.hipY, -0.005], [0, M.navelY, 0]);
    bone("spine", "pelvis", [0, M.navelY, -0.02], [0, M.chestY - 0.06, -0.01]);
    bone("chest", "spine", [0, M.chestY - 0.06, -0.01], [0, M.neckY, -0.03]);
    bone("neck", "chest", [0, M.neckY, -0.03], [0, M.chinY + 0.035, -0.012]);
    bone("head", "neck", [0, M.chinY + 0.035, -0.012], [0, M.topY, 0]);
    for (const side of [1, -1] as const) {
        const S = side > 0 ? "L" : "R";
        const sh: Vec3 = [side * M.shoulderX, M.shoulderY - 0.022, -0.035];
        bone(`clavicle${S}`, "chest", [side * 0.022, M.neckY - 0.01, 0.03], sh);
        // Rest arms hang straight down, palms facing the thighs.
        const elbow: Vec3 = [sh[0], sh[1] - M.upperArm, sh[2]];
        const wrist: Vec3 = [elbow[0], elbow[1] - M.foreArm, elbow[2]];
        bone(`upperarm${S}`, `clavicle${S}`, sh, elbow);
        bone(`forearm${S}`, `upperarm${S}`, elbow, wrist);
        const knuckle: Vec3 = [wrist[0], wrist[1] - M.handLen * 0.48, wrist[2] + 0.004];
        bone(`hand${S}`, `forearm${S}`, wrist, knuckle);
        // Fingers 1..4 (index..little) from their knuckles; 0 is the thumb from the wrist's radial side.
        const fingerLens = [[0.046, 0.032, 0.028], [0.046, 0.027, 0.022], [0.05, 0.031, 0.024], [0.047, 0.029, 0.023], [0.037, 0.021, 0.02]];
        const k = mf(0.93, 1.0) * p.armLength;
        for (let f = 1; f <= 4; f++) {
            const across = (f - 2.5) * mf(0.0195, 0.0215); // toward the little finger, -z with the palms in
            const dropAt = [0, -0.002, 0, -0.004, -0.011][f];
            let base: Vec3 = [knuckle[0], knuckle[1] + dropAt * k, knuckle[2] - across];
            for (let j = 0; j < 3; j++) {
                const L = fingerLens[f][j] * k;
                const tip: Vec3 = [base[0], base[1] - L, base[2]];
                bone(`finger${S}${f as 1}${j as 0}`, j === 0 ? `hand${S}` : `finger${S}${f as 1}${(j - 1) as 0}`, base, tip);
                base = tip;
            }
        }
        // Thumb: from the wrist's front (+z is the thumb side with palms in), angled out and down.
        let tb: Vec3 = [wrist[0] - side * 0.006, wrist[1] - 0.022 * k, wrist[2] + 0.02 * k];
        const tl = [0.044, 0.032, 0.027];
        for (let j = 0; j < 3; j++) {
            const L = tl[j] * k;
            const d = j === 0 ? norm([-side * 0.3, -0.85, 0.4]) : norm([-side * 0.22, -0.95, 0.18]);
            const tip = add(tb, scl(d, L));
            bone(`finger${S}0${j as 0}`, j === 0 ? `hand${S}` : `finger${S}0${(j - 1) as 0}`, tb, tip);
            tb = tip;
        }
        // Legs.
        const hip: Vec3 = [side * M.hipX, M.hipY, -0.005];
        const knee: Vec3 = [side * M.kneeX, M.kneeY, 0.005];
        const ankle: Vec3 = [side * M.ankleX, M.ankleY, -0.012];
        bone(`thigh${S}`, "pelvis", hip, knee);
        bone(`shin${S}`, `thigh${S}`, knee, ankle);
        const ball: Vec3 = [side * (M.ankleX + 0.012), 0.025, ankle[2] + M.footLen * 0.7 - M.heelBack];
        bone(`foot${S}`, `shin${S}`, ankle, ball);
        bone(`toes${S}`, `foot${S}`, ball, [ball[0], 0.015, ball[2] + M.footLen * 0.24]);
    }
    // --- Pose ---
    const spec = POSE_SPECS[p.pose] ?? POSE_SPECS.relaxed;
    const local = new Map<BoneName, M3>();
    const E = (v: [number, number, number]) => m3euler(v[0], v[1], v[2]);
    local.set("pelvis", E(spec.pelvis));
    local.set("spine", E(spec.spine));
    local.set("chest", E(spec.chest));
    local.set("neck", m3mul(E(spec.neck), m3euler(p.headTilt * 0.4, p.headTurn * 0.35, 0)));
    local.set("head", m3mul(E(spec.head), m3euler(p.headTilt * 0.6, p.headTurn * 0.65, 0)));
    for (const side of [1, -1] as const) {
        const S = side > 0 ? "L" : "R";
        const mir = (mm: M3) => (side > 0 ? mm : mirrorM(mm));
        const sh = side > 0 ? spec.shoulder : spec.shoulderR ?? spec.shoulder;
        const el = side > 0 ? spec.elbow : spec.elbowR ?? spec.elbow;
        const wr = side > 0 ? spec.wrist : spec.wristR ?? spec.wrist;
        const raise = sh[0] + p.armRaise;
        // The clavicle lifts a little as the arm goes above shoulder height.
        const clav = Math.max(0, raise - 70) * 0.25;
        local.set(`clavicle${S}`, mir(m3axis([0, 0, 1], clav)));
        // Abduct about z (the left arm out toward +x), flex forward (the hand toward +z), twist about the arm.
        local.set(`upperarm${S}`, mir(m3mul(m3axis([0, 0, 1], raise - clav), m3mul(m3axis([-1, 0, 0], sh[1]), m3axis([0, 1, 0], sh[2])))));
        // Elbow flexion brings the forearm forward.
        local.set(`forearm${S}`, mir(m3mul(m3axis([-1, 0, 0], el + p.elbowBend), m3axis([0, 1, 0], spec.forearmTwist))));
        local.set(`hand${S}`, mir(m3mul(m3axis([-1, 0, 0], wr[0]), m3axis([0, 0, 1], wr[1]))));
        const curl = clamp(p.fingerCurl + (spec.curl ?? 0), -0.3, 1);
        for (let f = 0; f <= 4; f++) for (let j = 0; j < 3; j++) {
            // The left palm faces -x: fingers flex about z toward it; the thumb about a tilted axis.
            const amount = f === 0 ? [12, 22, 24][j] : [52, 78, 50][j];
            const spread = f === 0 ? 0 : j === 0 ? (f - 2.5) * -3 * (1 - curl) : 0;
            const ang = amount * curl + (f === 0 && j === 0 ? 10 : 0);
            const axis: Vec3 = f === 0 ? norm([0.35, 0, 1]) : [0, 0, 1];
            local.set(`finger${S}${f as 1}${j as 0}`, mir(m3mul(m3axis(axis, -ang), m3axis([1, 0, 0], spread))));
        }
        const hipSpec = side > 0 ? spec.hipL : spec.hipR;
        local.set(`thigh${S}`, mir(m3mul(m3axis([-1, 0, 0], hipSpec[0]), m3mul(m3axis([0, 0, 1], hipSpec[1]), m3axis([0, 1, 0], hipSpec[2])))));
        local.set(`shin${S}`, mir(m3axis([1, 0, 0], side > 0 ? spec.kneeL : spec.kneeR)));
        // Heels point the foot down; the toes bend back up to stay on the ground.
        const heelAngle = (Math.atan2(p.heel, M.footLen * 0.7) * 180) / Math.PI;
        local.set(`foot${S}`, mir(m3axis([1, 0, 0], (side > 0 ? spec.ankleL : spec.ankleR) + heelAngle)));
        local.set(`toes${S}`, mir(m3axis([1, 0, 0], -heelAngle * 0.9)));
    }
    // Forward kinematics: R_child = R_parent * local, the head carried by the parent's motion.
    const order: BoneName[] = [];
    const visit = (n: BoneName) => { order.push(n); for (const b of bones.values()) if (b.parent === n) visit(b.name); };
    visit("pelvis");
    for (const name of order) {
        const b = bones.get(name)!;
        const L = local.get(name) ?? I3;
        if (!b.parent) { b.R = L; b.posedHead = b.head; continue; }
        const P = bones.get(b.parent)!;
        b.R = m3mul(P.R, L);
        b.posedHead = add(m3apply(P.R, sub(b.head, P.head)), P.posedHead);
    }
    return {
        bones,
        pt: (name, q) => { const b = bones.get(name)!; return add(m3apply(b.R, sub(q, b.head)), b.posedHead); },
        rot: (name, mm = I3) => m3mul(bones.get(name)!.R, mm),
    };
}

// --- The body field ------------------------------------------------------------------------------

export interface FigureHandle {
    params: FigureParams;
    measures: Measures;
    skeleton: Skeleton;
    /** The skin surface (meters, standing on the floor). */
    body: SdfNode;
    field: Field;
    /** Body box (meters). */
    box: Box;
    /** Head: centre and posed rotation of the cranium ellipsoid the scalp lies on, and its radii. */
    head: { center: Vec3; R: M3; radii: Vec3; eyeY: number; hu: number };
    /** A cached trilinear sampler of the body field for collisions. */
    collider(): LazyGrid;
    /** A bone's joint (`at` 0) or a point along it, in meters. */
    joint(bone: BoneName, at?: number): Vec3;
    /** A rest-space (reference units) point carried into the final pose and scale. */
    toWorld(bone: BoneName, restPoint: Vec3): Vec3;
    /** Meters per reference unit, and the floor lift applied after scaling. */
    scale: number;
    lift: number;
    /** The body's pieces in meters, for fitting garments and shoes. */
    segments: Record<SegmentName, SdfNode>;
    /** A point in head units (origin between the eyes, +y up, +z out of the face) in the world. */
    headPoint(x: number, y: number, z: number): Vec3;
    /** A head-local direction in the world (unit length). */
    headDir(x: number, y: number, z: number): Vec3;
}

/** Named pieces of the body a garment can be fitted over (reference units before scaling). */
export type SegmentName = "torso" | "neck" | "head" | "upperArmL" | "upperArmR" | "forearmL" | "forearmR" | "handL" | "handR"
    | "thighL" | "thighR" | "shinL" | "shinR" | "footL" | "footR";

interface Anatomy {
    node: SdfNode;
    segments: Record<SegmentName, SdfNode>;
    lips: SdfNode;
    nails: { c: Vec3; n: Vec3; r: number }[];
    eyes: { c: Vec3; R: M3; r: number }[];
    flush: { c: Vec3; r: number; k: number }[];
    regions: DetailRegion[];
}

function anatomy(p: FigureParams, M: Measures, sk: Skeleton): Anatomy {
    const { m, fat, mus, hu } = M;
    const mf = (f: number, mm: number) => lerp(f, mm, m);
    const P = sk.pt, Rb = sk.rot;
    const E = (b: BoneName, c: Vec3, r: Vec3, local: M3 = I3) => ellipsoid(P(b, c), r, toRot(Rb(b, local)));
    const RC = (b: BoneName, a: Vec3, bb: Vec3, ra: number, rb: number, squash: [number, number] = [1, 1], forward: Vec3 = [0, 0, 1]) =>
        roundCone(P(b, a), P(b, bb), ra, rb, squash, m3apply(Rb(b), forward));
    const RC2 = (ba: BoneName, a: Vec3, bb: BoneName, b: Vec3, ra: number, rb: number, squash: [number, number] = [1, 1], forward: Vec3 = [0, 0, 1]) =>
        roundCone(P(ba, a), P(bb, b), ra, rb, squash, m3apply(Rb(ba), forward));
    const S = (b: BoneName, c: Vec3, r: number) => sphere(P(b, c), r);
    const nails: Anatomy["nails"] = [];
    const flush: Anatomy["flush"] = [];
    const eyes: Anatomy["eyes"] = [];
    const segs: Partial<Record<SegmentName, SdfNode>> = {};

    // ---------- Torso ----------
    const W = lerp(0.9, 1.25, fat) * p.waist, F = lerp(0.92, 1.22, fat);
    const hipsW = lerp(0.92, 1.1, (p.hips - 0.8) / 0.4) * lerp(0.95, 1.12, fat);
    const shW = lerp(0.9, 1.1, (p.shoulders - 0.8) / 0.4);
    const torsoParts: SdfNode[] = [];
    const hy = M.hipY, cy = M.chestY;
    // Pelvis and lower abdomen.
    torsoParts.push(E("pelvis", [0, hy + 0.035, -0.012], [mf(0.152, 0.142) * hipsW, 0.105, mf(0.098, 0.096) * F]));
    torsoParts.push(E("pelvis", [0, hy + 0.08, 0.012], [0.13 * W, 0.09, 0.075 * lerp(0.95, 1.3, fat)]));
    // Belly: a soft mass that grows forward and down with weight.
    torsoParts.push(E("spine", [0, M.navelY - 0.01 - fat * 0.02, 0.022 + fat * 0.02], [0.115 * W, 0.095 + fat * 0.02, 0.055 + fat * 0.055]));
    // Waist.
    torsoParts.push(E("spine", [0, M.waistY, -0.008], [mf(0.115, 0.13) * W, 0.11, 0.085 * F]));
    // Rib cage and upper chest.
    torsoParts.push(E("chest", [0, cy - 0.025, -0.012], [mf(0.13, 0.148) * shW * lerp(0.97, 1.12, fat), mf(0.15, 0.165), mf(0.098, 0.11) * F]));
    torsoParts.push(E("chest", [0, cy + 0.085, -0.025], [mf(0.14, 0.162) * shW, 0.085, mf(0.085, 0.092)]));
    // Back: shoulder blades and the long muscles either side of the spine.
    for (const sd of [1, -1]) {
        torsoParts.push(E("chest", [sd * 0.07, cy + 0.055, -0.07], [0.055, 0.075, 0.03], m3axis([0, 0, 1], sd * 12)));
        torsoParts.push(E("spine", [sd * 0.035, M.waistY + 0.02, -0.07], [0.035, 0.13, 0.03]));
    }
    // Pectorals.
    const pec = lerp(0.6, 1.25, mus) * m + 0.35 * (1 - m);
    for (const sd of [1, -1]) torsoParts.push(E("chest", [sd * 0.068, cy + 0.035, 0.055], [0.078 * shW, 0.058, 0.03 + 0.018 * pec], m3axis([0, 0, 1], -sd * 18)));
    // Glutes and hip flesh.
    const glute = mf(1.12, 0.95) * lerp(0.92, 1.18, fat) * lerp(0.95, 1.08, mus);
    for (const sd of [1, -1]) {
        torsoParts.push(E("pelvis", [sd * 0.064, hy - 0.04, -0.07], [0.083 * glute, 0.098 * glute, 0.07 * glute], m3axis([0, 0, 1], sd * 8)));
        torsoParts.push(E("pelvis", [sd * mf(0.108, 0.1) * hipsW, hy - 0.025, -0.012], [0.06 * hipsW, 0.1, 0.076], m3axis([0, 0, 1], -sd * 6)));
    }
    let torso = union(torsoParts, 0.07);
    // Breasts: blended with a tighter radius so they keep their shape.
    const bustK = (1 - m) * clamp(p.bust, 0, 1);
    if (bustK > 0.02) {
        // A teardrop resting on the chest wall: broad at the base, projecting less than it is wide.
        const br = (0.042 + 0.022 * bustK) * lerp(0.95, 1.15, fat);
        const breasts: SdfNode[] = [];
        for (const sd of [1, -1]) {
            const c: Vec3 = [sd * 0.08 * shW, cy - 0.018 - 0.012 * bustK, 0.058 + 0.016 * bustK];
            breasts.push(E("chest", c, [br, br * 0.88, br * (0.5 + 0.25 * bustK)], m3mul(m3axis([0, 1, 0], sd * 16), m3axis([1, 0, 0], 14))));
            breasts.push(E("chest", add(c, [0, br * 0.45, -0.012]), [br * 0.85, br * 0.6, br * 0.35], m3axis([0, 1, 0], sd * 16)));
        }
        torso = union([torso, ...breasts], 0.03);
    }
    // Navel and the spine's groove.
    torso = subtract(torso, [E("spine", [0, M.navelY, 0.083 + fat * 0.045], [0.0065, 0.009, 0.012]), capsule(P("spine", [0, M.waistY - 0.04, -0.094]), P("chest", [0, cy + 0.02, -0.104]), 0.004)], 0.018);

    // ---------- Neck and shoulders ----------
    const neckR = mf(0.05, 0.057) * lerp(0.95, 1.15, fat) * lerp(0.95, 1.1, mus);
    const neck: SdfNode[] = [RC("neck", [0, M.neckY - 0.02, -0.03], [0, M.chinY + 0.03, -0.012], neckR * 1.08, neckR * 0.92, [1.05, 0.95])];
    // Sternocleidomastoid cords, from behind the ear to the top of the sternum.
    for (const sd of [1, -1]) neck.push(RC2("head", [sd * 0.05 * hu, M.eyeY - 0.045 * hu, -0.035 * hu], "chest", [sd * 0.016, M.neckY - 0.008, 0.035], 0.012, 0.009));
    if (m > 0.4) neck.push(E("neck", [0, M.chinY - 0.03, 0.04], [0.011, 0.015, 0.011]));
    // Trapezius slopes from the neck to the shoulders; clavicles ridge the front.
    const shoulderParts: SdfNode[] = [];
    for (const sd of [1, -1]) {
        const cl = (sd > 0 ? "clavicleL" : "clavicleR") as BoneName;
        shoulderParts.push(RC2("chest", [sd * 0.035, M.neckY + 0.012, -0.045], cl, [sd * (M.shoulderX - 0.02), M.shoulderY - 0.005, -0.04], 0.04 * lerp(0.9, 1.2, mus), 0.03));
        shoulderParts.push(RC2("chest", [sd * 0.02, M.neckY - 0.014, 0.028], cl, [sd * (M.shoulderX - 0.012), M.shoulderY - 0.014, -0.012], 0.0055, 0.006));
    }

    // ---------- Arms and hands ----------
    const arms: SdfNode[] = [];
    const hands: SdfNode[] = [];
    for (const sd of [1, -1] as const) {
        const L = sd > 0 ? "L" : "R";
        const ua = `upperarm${L}` as BoneName, fa = `forearm${L}` as BoneName, hd = `hand${L}` as BoneName;
        const sh = sk.bones.get(ua)!.head, el = sk.bones.get(fa)!.head, wr = sk.bones.get(hd)!.head;
        const armR = mf(0.04, 0.046) * lerp(0.9, 1.25, fat) * lerp(0.95, 1.12, mus);
        const upper = union([
            // Deltoid capping the shoulder, the upper arm, biceps in front and triceps behind.
            E(ua, add(sh, [sd * 0.012, -0.045, 0.0]), [0.05 * lerp(0.9, 1.25, mus) * lerp(0.95, 1.1, fat), 0.085, 0.056 * lerp(0.9, 1.2, mus)]),
            RC(ua, add(sh, [0, -0.03, 0]), el, armR, armR * 0.78, [0.95, 1.05]),
            E(ua, lerp3(sh, el, 0.55), [0.03 * lerp(0.85, 1.3, mus), 0.075, 0.03 * lerp(0.8, 1.45, mus)]),
            E(ua, add(lerp3(sh, el, 0.5), [0, 0, 0.018]), [0.026, 0.07, 0.024 * lerp(0.8, 1.6, mus)]),
            E(ua, add(lerp3(sh, el, 0.45), [0, 0, -0.018]), [0.028, 0.08, 0.024 * lerp(0.85, 1.3, mus) * lerp(0.95, 1.25, fat)]),
        ], 0.045);
        // Forearm: round at the elbow, flattening into the wrist; the brachioradialis swell up top.
        const foreR = armR * 0.86;
        const fore = union([
            S(fa, add(el, [0, 0, -0.008]), foreR * 0.92),
            RC(fa, add(el, [0, -0.01, 0]), add(wr, [0, 0.012, 0]), foreR, mf(0.021, 0.024) * lerp(0.95, 1.1, fat), [0.82, 1.18]),
            E(fa, add(lerp3(el, wr, 0.28), [-sd * 0.002, 0, 0.012]), [0.028 * lerp(0.9, 1.25, mus), 0.065, 0.026]),
            E(fa, add(lerp3(el, wr, 0.3), [0, 0, -0.012]), [0.026, 0.07, 0.024]),
        ], 0.035);
        arms.push(union([upper, fore], 0.03));
        segs[`upperArm${L}` as SegmentName] = upper;
        segs[`forearm${L}` as SegmentName] = fore;
        flush.push({ c: P(fa, add(el, [0, 0, -0.03])), r: 0.03, k: 0.25 });

        // Hand: palm, thenar pad, fingers blended to the palm only.
        const k = mf(0.93, 1.0) * p.armLength;
        const kn = sk.bones.get(hd)!.tail;
        // The palm: a rounded slab (its face toward the body is -x on the left hand), the thumb's
        // pad and the little-finger edge on its inner face, the wrist's root.
        // Four metacarpals fanning from the wrist to the knuckles make the palm: convex across the
        // back, tapering to the wrist. The thumb's pad and the little-finger edge fill its inner face.
        const metas: SdfNode[] = [];
        for (let f = 1; f <= 4; f++) {
            const base = sk.bones.get(`finger${L}${f as 1}0` as BoneName)!.head;
            const root = add(wr, [0, -0.012, (base[2] - wr[2]) * 0.35]);
            metas.push(RC(hd, root, add(base, [0, 0.004, 0]), mf(0.0115, 0.013) * k, mf(0.0108, 0.0122) * k, [0.78, 1.25]));
        }
        const palm = union([
            union(metas, 0.018),
            E(hd, lerp3(wr, kn, 0.1), [0.0135 * k, 0.02, 0.024 * k]),
            E(hd, add(lerp3(wr, kn, 0.36), [-sd * 0.008, 0, 0.02 * k]), [0.011, 0.028, 0.016], m3axis([0, 0, 1], sd * 10)),
            E(hd, add(lerp3(wr, kn, 0.5), [-sd * 0.006, 0, -0.028 * k]), [0.009, 0.034, 0.01]),
        ], 0.01);
        const fingerParts: SdfNode[] = [];
        for (let f = 0; f <= 4; f++) {
            const r0 = (f === 0 ? 0.011 : f === 4 ? 0.0084 : 0.0098) * mf(0.92, 1.05) * lerp(0.95, 1.12, fat);
            const segs: SdfNode[] = [];
            for (let j = 0; j < 3; j++) {
                const bn = `finger${L}${f as 1}${j as 0}` as BoneName;
                const b = sk.bones.get(bn)!;
                const ra = r0 * [1, 0.88, 0.8][j], rb = r0 * [0.9, 0.82, 0.68][j];
                // Fingers are wider than deep: flatten them across the back of the hand.
                segs.push(RC(bn, b.head, j === 2 ? lerp3(b.head, b.tail, 0.86) : b.tail, ra, rb, [0.86, 1.06]));
                if (j === 2) {
                    // A nail on the back of the last segment (the back of the left hand faces +x).
                    nails.push({ c: P(bn, add(lerp3(b.head, b.tail, 0.62), [sd * rb * 0.75, 0, 0])), n: m3apply(Rb(bn), [sd, 0, 0]), r: rb * 1.05 });
                }
            }
            // The finger's root blends into the palm (webbing); fingers don't blend with each other.
            fingerParts.push(union([palm, union(segs, 0.004)], f === 0 ? 0.016 : 0.01));
        }
        hands.push(union(fingerParts, 0));
        segs[`hand${L}` as SegmentName] = hands[hands.length - 1];
        flush.push({ c: P(hd, kn), r: 0.035, k: 0.18 });
        for (let f = 0; f <= 4; f++) { const bn = `finger${L}${f as 1}2` as BoneName; flush.push({ c: P(bn, sk.bones.get(bn)!.tail), r: 0.012, k: 0.35 }); }
    }

    // ---------- Legs and feet ----------
    const legs: SdfNode[] = [];
    for (const sd of [1, -1] as const) {
        const L = sd > 0 ? "L" : "R";
        const th = `thigh${L}` as BoneName, sh = `shin${L}` as BoneName, ft = `foot${L}` as BoneName, to = `toes${L}` as BoneName;
        const hip = sk.bones.get(th)!.head, knee = sk.bones.get(sh)!.head, ank = sk.bones.get(ft)!.head;
        const ball = sk.bones.get(to)!.head, toeTip = sk.bones.get(to)!.tail;
        const thighR = mf(0.082, 0.08) * lerp(0.92, 1.25, fat) * lerp(0.95, 1.1, mus);
        const thigh = union([
            RC(th, add(hip, [sd * 0.01, 0.0, 0.0]), add(knee, [0, 0.03, 0]), thighR, 0.053 * lerp(0.95, 1.12, fat)),
            // Quadriceps in front (vastus medialis swelling above the inner knee), hamstrings behind, adductors inside.
            E(th, add(lerp3(hip, knee, 0.45), [sd * 0.008, 0, 0.03]), [0.052, 0.15, 0.045 * lerp(0.9, 1.25, mus)]),
            E(th, add(lerp3(hip, knee, 0.82), [-sd * 0.022, 0, 0.022]), [0.032, 0.05, 0.03 * lerp(0.9, 1.25, mus)]),
            E(th, add(lerp3(hip, knee, 0.4), [0, 0, -0.03]), [0.05, 0.15, 0.045]),
            E(th, add(lerp3(hip, knee, 0.22), [-sd * 0.03, 0, 0.0]), [0.05 * lerp(0.95, 1.2, fat), 0.11, 0.06]),
            E(th, add(lerp3(hip, knee, 0.15), [sd * 0.035, 0, -0.005]), [0.055 * mf(1.12, 0.95) * lerp(0.95, 1.15, fat), 0.1, 0.065]),
        ], 0.05);
        const kneeR = 0.047 * lerp(0.95, 1.08, fat);
        const kneeN = union([S(sh, add(knee, [0, 0.005, -0.006]), kneeR), E(sh, add(knee, [0, 0.008, kneeR * 0.82]), [0.022, 0.026, 0.012])], 0.02);
        const calf = lerp(0.9, 1.25, mus) * lerp(0.95, 1.15, fat);
        const shin = union([
            RC(sh, add(knee, [0, -0.02, -0.005]), add(ank, [0, 0.03, 0]), 0.048 * lerp(0.95, 1.12, fat), 0.028, [0.95, 1.05]),
            // Gastrocnemius: two heads, the inner one lower.
            E(sh, add(lerp3(knee, ank, 0.27), [sd * 0.018, 0, -0.032]), [0.033 * calf, 0.09, 0.037 * calf]),
            E(sh, add(lerp3(knee, ank, 0.31), [-sd * 0.018, 0, -0.032]), [0.034 * calf, 0.095, 0.039 * calf]),
            E(sh, add(lerp3(knee, ank, 0.25), [sd * 0.026, 0, 0.004]), [0.024, 0.09, 0.03]),
        ], 0.04);
        const ankle = union([S(sh, add(ank, [sd * 0.019, 0.004, -0.006]), 0.0115), S(sh, add(ank, [-sd * 0.018, 0.012, -0.002]), 0.0115)], 0);
        // Foot: heel, the arch and the ball, toes (shaped only when barefoot).
        const fw = mf(0.042, 0.047);
        const heel = add(ank, [0, -0.05, -M.heelBack + 0.026]);
        const footParts: SdfNode[] = [
            E(ft, heel, [0.029, 0.027, 0.031]),
            // Achilles tendon from the calf down to the heel.
            RC(ft, add(heel, [0, 0.015, -0.006]), add(ank, [0, 0.06, -0.03]), 0.016, 0.014, [1.2, 0.8]),
            RC(ft, add(heel, [0, -0.002, 0.02]), add(ball, [-sd * 0.004, 0.006, -0.01]), 0.027, 0.02, [1.5, 0.82]),
            E(ft, add(lerp3(ank, ball, 0.4), [sd * 0.004, -0.012, 0.0]), [0.031, 0.024, 0.055]),
            E(to, add(ball, [-sd * 0.004, -0.002, 0.004]), [fw, 0.016, 0.024]),
        ];
        let foot = union(footParts, 0.02);
        if (p.toes) {
            const toeLens = [0.036, 0.031, 0.028, 0.025, 0.021];
            const toeR = [0.0105, 0.0072, 0.0068, 0.0064, 0.006];
            const toeX = [-0.027, -0.0075, 0.0055, 0.0175, 0.0285];
            const toes: SdfNode[] = [];
            for (let t = 0; t < 5; t++) {
                const x = sd * toeX[t] * (fw / 0.045);
                const back = [0, 0.004, 0.01, 0.017, 0.025][t];
                const a = add(ball, [x, 0.001, 0.014 - back]);
                const b = add(a, [sd * t * 0.0015, -0.004, toeLens[t]]);
                // Each toe blends into the ball of the foot, never into its neighbours.
                toes.push(union([foot, RC(to, a, b, toeR[t], toeR[t] * 0.9, [1.05, 0.8])], 0.008));
                nails.push({ c: P(to, add(b, [0, toeR[t] * 0.75, -toeR[t] * 0.35])), n: m3apply(Rb(to), norm([0, 1, 0.3])), r: toeR[t] * 0.72 });
            }
            foot = union(toes, 0);
        } else {
            foot = union([foot, RC(to, add(ball, [-sd * 0.004, 0.0, 0.01]), toeTip, 0.02, 0.014, [1.7, 0.75])], 0.02);
        }
        legs.push(union([union([thigh, kneeN], 0.04), shin, ankle, foot], 0.035));
        segs[`thigh${L}` as SegmentName] = union([thigh, kneeN], 0.04);
        segs[`shin${L}` as SegmentName] = union([shin, ankle], 0.03);
        segs[`foot${L}` as SegmentName] = foot;
        flush.push({ c: P(sh, add(knee, [0, 0, 0.04])), r: 0.04, k: 0.2 });
        flush.push({ c: P(ft, heel), r: 0.04, k: 0.25 });
    }

    // ---------- Head ----------
    const hb: BoneName = "head";
    // Head-local coordinates: origin between the eyes, scaled by the head unit.
    const hp = (x: number, y: number, z: number): Vec3 => [x * hu, M.eyeY + y * hu, z * hu];
    const hr = (x: number, y: number, z: number): Vec3 => [x * hu, y * hu, z * hu];
    const HE = (c: Vec3, r: Vec3, local: M3 = I3) => E(hb, c, r, local);
    const face = (v: number) => lerp(0.5, 1.5, v); // 0..1 control -> 0.5..1.5 factor
    const fatFace = lerp(0.95, 1.18, fat);
    const jaw = face(p.jawWidth) * mf(0.95, 1.06);
    // The head blank: one smooth form lofted from chin to crown, a superellipse cross-section at
    // every height whose half-width and front/back depths follow measured profiles (head units, the
    // origin between the eyes). Features are then added on top with small blends.
    const cheekF = face(p.cheekbones), chinF = face(p.chin);
    const blank = headBlank(P(hb, hp(0, 0, 0)), Rb(hb), hu, {
        jaw: jaw * fatFace ** 0.5, cheek: lerp(0.96, 1.05, (cheekF - 0.5)) , fat: fatFace, chin: chinF, m,
    });
    const faceParts: SdfNode[] = [];
    // Cheekbones (malar), the chin's point, brows.
    for (const sd of [1, -1]) faceParts.push(HE(hp(sd * 0.044, -0.017 + p.smile * 0.003, 0.04), hr(0.017 * cheekF, 0.009 * cheekF, 0.014), m3axis([0, 1, 0], sd * 32)));
    faceParts.push(HE(hp(0, -0.099 - 0.004 * (chinF - 1), 0.07 + 0.006 * (chinF - 1)), hr(mf(0.017, 0.022) * chinF, 0.014, 0.012)));
    const browF = face(p.browRidge) * mf(0.8, 1.15);
    for (const sd of [1, -1]) faceParts.push(HE(hp(sd * 0.03, 0.019, 0.066), hr(0.024, 0.008 * browF, 0.011 * browF), m3axis([0, 1, 0], sd * 18)));
    let head = union([blank, union(faceParts, 0.008)], 0.012);

    // Eyes: each eyeball pushes the lids out of the face; a crease under the brow, and the almond
    // opening cut through the lids to the eyeball.
    const eg = eyeGeometry(p);
    const eyeR = eg.r * hu, eyeX = eg.x;
    const sockets: SdfNode[] = [], creases: SdfNode[] = [], lids: SdfNode[] = [], openings: SdfNode[] = [];
    for (const sd of [1, -1]) {
        const ec = hp(sd * eyeX, 0, eg.z);
        // The orbit recesses the face round the eye, deepest under the brow and at the inner corner.
        sockets.push(HE(add(ec, hr(sd * 0.001, 0.001, 0.013)), hr(0.0185, 0.0115, 0.0105)));
        // The upper lid's crease sits just outside the lid, where it tucks under the brow.
        creases.push(HE(add(ec, hr(sd * 0.001, 0.0142, 0.0108)), hr(0.0145, 0.0028, 0.0038), m3axis([0, 0, 1], sd * 4)));
        lids.push(sphere(P(hb, ec), eyeR + 0.0011 * hu));
        const open = eg.open;
        openings.push(HE(add(ec, [0, -0.0009 * hu, eyeR * 0.98]), [eyeR * 1.1 * open, eyeR * 0.35 * open, eyeR * 0.62], m3axis([0, 0, 1], sd * 7)));
        eyes.push({ c: P(hb, ec), R: Rb(hb), r: eyeR });
    }
    head = subtract(head, sockets, 0.01 * hu);
    head = union([head, ...lids], 0.007 * hu);
    head = subtract(head, creases, 0.005 * hu);
    head = subtract(head, openings, 0.001 * hu);

    // Nose: a narrow bridge widening to the tip, the nose's body with its side planes, the tip,
    // the wings (alae) folding into the cheeks, and the columella down to the lip.
    const nL = face(p.noseLength), nW = face(p.noseWidth), nB = face(p.noseBridge);
    const tip = hp(0, -0.036 * lerp(0.85, 1.15, nL - 0.5), 0.098 + 0.004 * (nB - 1));
    const noseParts: SdfNode[] = [
        roundCone(P(hb, hp(0, 0.006, 0.075)), P(hb, add(tip, hr(0, 0.006, -0.005))), 0.0052 * hu * nB, 0.0075 * hu * nW ** 0.5, [1.25, 0.8], m3apply(Rb(hb), [0, 0, 1])),
        HE(hp(0, tip[1] / hu - M.eyeY / hu + 0.016, 0.084), hr(0.0115 * nW ** 0.6, 0.017, 0.0115)),
        HE(tip, hr(0.0092 * nW ** 0.4, 0.0074, 0.0078)),
        roundCone(P(hb, add(tip, hr(0, -0.004, -0.003))), P(hb, hp(0, -0.045, 0.086)), 0.0042 * hu, 0.0036 * hu),
    ];
    for (const sd of [1, -1]) noseParts.push(HE(add(tip, hr(sd * 0.0108 * nW, -0.0058, -0.0108)), hr(0.0052 * nW ** 0.5, 0.0048, 0.0068), m3axis([0, 1, 0], sd * 30)));
    head = union([head, union(noseParts, 0.0065 * hu)], 0.009 * hu);
    const nostrils: SdfNode[] = [];
    for (const sd of [1, -1]) nostrils.push(HE(add(tip, hr(sd * 0.0064 * nW, -0.0102, -0.0065)), hr(0.0032 * nW, 0.0018, 0.005), m3axis([0, 1, 0], sd * 22)));
    head = subtract(head, nostrils, 0.0012 * hu);

    // Lips: two soft cushions whose meeting is the mouth's line, corners tucked in (and lifted by a smile).
    const lipF = face(p.lips) * mf(1.05, 0.88), mW = face(p.mouthWidth) ** 0.6;
    // Each lip is a row of soft segments following the dental arch, so the corners tuck back.
    const arch = 0.034, smileLift = p.smile * 0.004;
    const lipRow = (y: number, z: number, ry: number, rz: number, halfW: number, bow: number): SdfNode[] => {
        const out: SdfNode[] = [];
        for (let k = -3; k <= 3; k++) {
            const t = k / 3, x = t * halfW * mW;
            const taper = 1 - 0.55 * Math.abs(t) ** 1.6;
            const lift = Math.abs(t) > 0.5 ? smileLift * (Math.abs(t) - 0.5) * 2 : 0;
            const peak = bow * Math.exp(-(((Math.abs(t) - 0.28) / 0.2) ** 2));
            out.push(HE(hp(x, y + lift + peak, z - (x * x) / (2 * arch)), hr(halfW * mW * 0.36, ry * lipF * (0.55 + 0.45 * taper), rz * lipF * taper), m3axis([0, 1, 0], (-Math.asin(Math.max(-1, Math.min(1, x / arch))) * 180) / Math.PI)));
        }
        return out;
    };
    const upper = lipRow(-0.0655, 0.0802, 0.0038, 0.006, 0.0205, 0.0008);
    const lower = lipRow(-0.0738, 0.0782, 0.0047, 0.0066, 0.018, 0);
    const lipNode = union([union(upper, 0.004 * hu), union(lower, 0.004 * hu)], 0.0012 * hu);
    head = union([head, lipNode], 0.004 * hu);
    const mouthCuts: SdfNode[] = [];
    for (const sd of [1, -1]) mouthCuts.push(sphere(P(hb, hp(sd * 0.0215 * mW, -0.0697 + smileLift, 0.0738)), 0.0018 * hu));
    head = subtract(head, mouthCuts, 0.0018 * hu);
    // A shallow philtrum.
    head = subtract(head, HE(hp(0, -0.054, 0.0862), hr(0.0028, 0.0065, 0.0013)), 0.0022 * hu);

    // Ears: a tilted shell with the bowl (concha) and the rim's fold carved in.
    const earF = face(p.earSize) ** 0.7;
    const ears: SdfNode[] = [];
    for (const sd of [1, -1]) {
        const ec = hp(sd * 0.073, -0.006, -0.014);
        const er = m3mul(m3axis([0, 1, 0], sd * 12), m3axis([1, 0, 0], -14));
        const shell = union([
            ellipsoid(P(hb, ec), [0.0095 * hu, 0.03 * hu * earF, 0.019 * hu * earF], toRot(Rb(hb, er))),
            ellipsoid(P(hb, add(ec, hr(0, -0.022 * earF, 0.002))), [0.006 * hu, 0.009 * hu * earF, 0.008 * hu], toRot(Rb(hb, er))),
        ], 0.004 * hu);
        const ax = m3apply(er, [sd, 0, 0]);
        const concha = ellipsoid(P(hb, add(ec, add(scl(ax, 0.0085 * hu), hr(0, -0.005, 0.003)))), [0.0055 * hu, 0.012 * hu * earF, 0.0085 * hu * earF], toRot(Rb(hb, er)));
        const scapha = ellipsoid(P(hb, add(ec, add(scl(ax, 0.009 * hu), hr(0, 0.013 * earF, -0.002)))), [0.004 * hu, 0.012 * hu * earF, 0.0105 * hu * earF], toRot(Rb(hb, er)));
        ears.push(subtract(shell, [concha, scapha], 0.0025 * hu));
        flush.push({ c: P(hb, ec), r: 0.03 * hu, k: 0.3 });
    }
    head = union([head, ...ears], 0.006 * hu);
    flush.push({ c: P(hb, add(tip, hr(0, 0.0, -0.004))), r: 0.016 * hu, k: 0.35 });
    for (const sd of [1, -1]) flush.push({ c: P(hb, hp(sd * 0.042, -0.035, 0.07)), r: 0.03 * hu, k: 0.22 });

    // ---------- Assemble ----------
    const trunk = union([torso, union(neck, 0.03), union(shoulderParts, 0.03)], 0.045);
    segs.torso = union([torso, union(shoulderParts, 0.03)], 0.045);
    segs.neck = union(neck, 0.03);
    segs.head = head;
    const withLimbs = union([union([trunk, ...arms], 0.04), ...legs], 0.045);
    const body = union([union([withLimbs, ...hands], 0.012), head], 0.03);

    // Detail: fine on the face, ears and hands, a little finer on the head and feet.
    const regions: DetailRegion[] = [
        { center: P(hb, hp(0, -0.035, 0.07)), radius: 0.065 * hu, size: 0.0019 },
        { center: P(hb, hp(0, 0, -0.01)), radius: 0.14 * hu, size: 0.004 },
        { center: P(hb, hp(0.074, -0.006, -0.014)), radius: 0.04 * hu, size: 0.0022 },
        { center: P(hb, hp(-0.074, -0.006, -0.014)), radius: 0.04 * hu, size: 0.0022 },
    ];
    for (const L of ["L", "R"]) {
        const hd = sk.bones.get(`hand${L}` as BoneName)!;
        regions.push({ center: sk.pt(`hand${L}` as BoneName, lerp3(hd.head, hd.tail, 1.25)), radius: 0.095, size: 0.0024 });
        const ft = sk.bones.get(`toes${L}` as BoneName)!;
        regions.push({ center: sk.pt(`toes${L}` as BoneName, ft.head), radius: 0.11, size: p.toes ? 0.0032 : 0.0055 });
    }
    return { node: body, segments: segs as Record<SegmentName, SdfNode>, lips: lipNode, nails, eyes, flush, regions };
}

/** Cubic Hermite through (x, values...) knots, tangents from neighbours; clamped at the ends. */
function profile(knots: number[][]): (x: number, out: number[]) => void {
    const n = knots.length, dims = knots[0].length - 1;
    const tan = knots.map((k, i) => {
        const a = knots[Math.max(0, i - 1)], b = knots[Math.min(n - 1, i + 1)];
        return Array.from({ length: dims }, (_, d) => (b[d + 1] - a[d + 1]) / (b[0] - a[0] || 1));
    });
    return (x, out) => {
        if (x <= knots[0][0]) { for (let d = 0; d < dims; d++) out[d] = knots[0][d + 1]; return; }
        if (x >= knots[n - 1][0]) { for (let d = 0; d < dims; d++) out[d] = knots[n - 1][d + 1]; return; }
        let i = 0;
        while (knots[i + 1][0] < x) i++;
        const a = knots[i], b = knots[i + 1], h = b[0] - a[0], t = (x - a[0]) / h;
        const t2 = t * t, t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
        for (let d = 0; d < dims; d++) out[d] = h00 * a[d + 1] + h10 * h * tan[i][d] + h01 * b[d + 1] + h11 * h * tan[i + 1][d];
    };
}

// Head profile, head units with the origin between the eyes: height, half-width, front and back.
const HEAD_PROFILE = profile([
    [-0.112, 0.004, 0.064, 0.046],
    [-0.106, 0.014, 0.076, 0.03],
    [-0.097, 0.025, 0.08, 0.006],
    [-0.084, 0.037, 0.081, -0.016],
    [-0.07, 0.046, 0.081, -0.028],
    [-0.052, 0.053, 0.082, -0.042],
    [-0.032, 0.0585, 0.079, -0.058],
    [-0.012, 0.063, 0.075, -0.074],
    [0.008, 0.065, 0.075, -0.088],
    [0.03, 0.069, 0.081, -0.1],
    [0.045, 0.0722, 0.081, -0.105],
    [0.06, 0.0703, 0.077, -0.108],
    [0.078, 0.063, 0.067, -0.106],
    [0.092, 0.0535, 0.052, -0.097],
    [0.103, 0.041, 0.035, -0.084],
    [0.11, 0.029, 0.02, -0.068],
    [0.1145, 0.017, 0.006, -0.052],
    [0.1167, 0.003, -0.012, -0.03],
]);

/**
 * The head's base form as a field: at height y the cross-section is a superellipse of half-width
 * rx(y) between z = zb(y) behind and zf(y) in front, flatter across the face than round the skull.
 */
function headBlank(origin: Vec3, R: M3, hu: number, f: { jaw: number; cheek: number; fat: number; chin: number; m: number }): SdfNode {
    const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = R;
    const [ox, oy, oz] = origin;
    const row = [0, 0, 0], slope = [0, 0, 0];
    const y0 = -0.112, y1 = 0.1167;
    const fn = (x: number, y: number, z: number) => {
        // World into head-local units.
        const px = (x - ox) / hu, py = (y - oy) / hu, pz = (z - oz) / hu;
        const lx = r0 * px + r3 * py + r6 * pz, ly = r1 * px + r4 * py + r7 * pz, lz = r2 * px + r5 * py + r8 * pz;
        const yy = ly < y0 ? y0 : ly > y1 ? y1 : ly;
        HEAD_PROFILE(yy, row);
        const row0 = row[0], row1 = row[1];
        let rx = row[0], zf = row[1];
        const zb = row[2];
        // Jaw and cheek widths, a fuller lower face, a stronger chin.
        const low = yy < -0.03 ? Math.min(1, (-0.03 - yy) / 0.04) : 0;
        const cheekBand = Math.exp(-(((yy + 0.012) / 0.025) ** 2));
        rx *= (1 + (f.jaw - 1) * low * 0.8) * (1 + (f.cheek - 1) * cheekBand) * (1 + (f.fat - 1) * low * 0.6);
        if (yy < -0.085) zf += (f.chin - 1) * 0.006 * Math.min(1, (-0.085 - yy) / 0.015);
        const zc = (zf + zb) * 0.5, rz = Math.max(1e-4, (zf - zb) * 0.5);
        const ex = Math.abs(lx) / Math.max(1e-4, rx), ez = Math.abs(lz - zc) / rz;
        const n = lz > zc ? lerp(2.5, 2.8, f.m) : 2.15;
        const q = Math.pow(Math.pow(ex, n) + Math.pow(ez, n), 1 / n);
        // A sideways distance, shortened where the profile changes fast with height (crown, chin).
        HEAD_PROFILE(yy + 0.002, slope);
        const sl = Math.max(Math.abs(slope[0] - row0), Math.abs(slope[1] - row1), Math.abs(slope[2] - zb)) / 0.002;
        let d = ((q - 1) * Math.min(Math.max(rx, 1e-4), rz) * 0.9) / Math.sqrt(1 + sl * sl);
        if (ly !== yy) d = Math.hypot(Math.max(d, 0), ly - yy);
        return d * hu;
    };
    const e = 0.16 * hu;
    // Box: generous about the origin in every direction the head can turn.
    return custom([ox - e, oy - e, oz - e, ox + e, oy + e, oz + e], fn);
}

/**
 * Each eye in head units (the origin between the eyes): its center's spacing and depth, the eyeball's
 * radius, and how open the lids are (the opening's half-height is 0.35 * r * open).
 */
export function eyeGeometry(p: FigureParams): { x: number; z: number; r: number; open: number } {
    return { x: 0.032 * lerp(0.94, 1.06, p.eyeSpacing), z: 0.0585, r: 0.0122 * lerp(0.94, 1.06, p.eyeSize), open: lerp(0.88, 1.1, p.eyeSize) };
}

/** A node scaled by `s` and lifted by `lift` (reference units into meters). */
export function scaledNode(node: SdfNode, s: number, lift: number): SdfNode {
    const b = node.box;
    let f: Field | null = null;
    const inv = 1 / s;
    const self: SdfNode = {
        box: [b[0] * s, b[1] * s + lift, b[2] * s, b[3] * s, b[4] * s + lift, b[5] * s],
        fn() { if (!f) { const g = node.fn(); f = (x, y, z) => g(x * inv, (y - lift) * inv, z * inv) * s; } return f; },
        spec(x, y, z, h, L) {
            const sp = node.spec(x * inv, (y - lift) * inv, z * inv, h * inv, L);
            SPEC.lo *= s; SPEC.hi *= s;
            return sp === node ? self : scaledNode(sp, s, lift);
        },
    };
    return self;
}

// --- Building ------------------------------------------------------------------------------------

export interface FigureMesh { mesh: Mesh; handle: FigureHandle }

/** Packs a 0..1 flush (skin redness) into uv.y for the skin shader. */
export const skinV = (flushAmount: number) => clamp(flushAmount, 0, 0.999);

const cache = new Map<string, FigureMesh>();

export function buildFigure(params: Partial<FigureParams> = {}): FigureMesh {
    const p: FigureParams = { ...DEFAULT_FIGURE, ...params };
    const key = JSON.stringify(p);
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    const M = measures(p);
    const sk = buildSkeleton(p, M);
    const A = anatomy(p, M, sk);
    const s = M.s;
    const detail = clamp(p.detail, 0.4, 3);
    // Meshed in reference units (no scaling wrapper in the hot loop), then scaled into meters.
    const rb = A.node.box;
    const fm = meshField(A.node, { box: [rb[0] - 0.02, rb[1] - 0.02, rb[2] - 0.02, rb[3] + 0.02, rb[4] + 0.02, rb[5] + 0.02], size: 0.0072 * detail, regions: A.regions.map(r => ({ ...r, size: r.size * detail })), lipschitz: 1.3 });
    // Plant the feet: the surface's lowest point (whatever the pose) rests on the floor, or on the
    // soles of the shoes the figure will wear.
    let lowest = Infinity;
    for (let i = 1; i < fm.positions.length; i += 3) if (fm.positions[i] < lowest) lowest = fm.positions[i];
    if (!Number.isFinite(lowest)) lowest = 0;
    const lift = -lowest * s + Math.max(0, p.sole);
    const body = scaledNode(A.node, s, lift);
    const W = (q: Vec3): Vec3 => [q[0] * s, q[1] * s + lift, q[2] * s];
    for (let i = 0; i < fm.positions.length; i += 3) { fm.positions[i] *= s; fm.positions[i + 1] = fm.positions[i + 1] * s + lift; fm.positions[i + 2] *= s; }
    const bb = body.box;
    const box: Box = [bb[0] - 0.02, Math.min(bb[1], 0) - 0.02, bb[2] - 0.02, bb[3] + 0.02, bb[4] + 0.02, bb[5] + 0.02];

    // Regions: lips and nails from where the surface is; everything else skin, with a flush in uv.y.
    const lipField = fieldOf(scaledNode(A.lips, s, lift));
    const nails = A.nails.map(n => ({ c: W(n.c), n: n.n, r: n.r * s }));
    const flush = A.flush.map(f => ({ c: W(f.c), r: f.r * s, k: f.k }));
    const Pp = fm.positions, N = fm.normals;
    const nv = Pp.length / 3;
    const vRegion = new Uint8Array(nv); // 0 skin, 1 lips, 2 nails
    const vFlush = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
        const x = Pp[v * 3], y = Pp[v * 3 + 1], z = Pp[v * 3 + 2];
        if (lipField(x, y, z) < 0.0009 * s) vRegion[v] = 1;
        for (const n of nails) {
            const dx = x - n.c[0], dy = y - n.c[1], dz = z - n.c[2];
            if (dx * dx + dy * dy + dz * dz < n.r * n.r && N[v * 3] * n.n[0] + N[v * 3 + 1] * n.n[1] + N[v * 3 + 2] * n.n[2] > 0.62) { vRegion[v] = 2; break; }
        }
        let fl = 0;
        for (const f of flush) {
            const d2 = (x - f.c[0]) ** 2 + (y - f.c[1]) ** 2 + (z - f.c[2]) ** 2;
            if (d2 < f.r * f.r) fl = Math.max(fl, f.k * (1 - Math.sqrt(d2) / f.r) ** 1.5);
        }
        vFlush[v] = fl;
    }
    const names = ["skin", "lips", "nails"];
    const parts = names.map(n => newPart(n));
    const remap = [new Int32Array(nv).fill(-1), new Int32Array(nv).fill(-1), new Int32Array(nv).fill(-1)];
    const I = fm.indices;
    const ids = [0, 0, 0];
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t], b = I[t + 1], c = I[t + 2];
        // A triangle takes the region most of its corners have.
        const ra = vRegion[a], rb = vRegion[b], rc = vRegion[c];
        const r = ra === rb || ra === rc ? ra : rb === rc ? rb : 0;
        const part = parts[r];
        for (let k = 0; k < 3; k++) {
            const i = I[t + k];
            let j = remap[r][i];
            if (j < 0) {
                j = vertex(part, [Pp[i * 3], Pp[i * 3 + 1], Pp[i * 3 + 2]], [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]], [y01(Pp[i * 3 + 1], box), skinV(vFlush[i])]);
                remap[r][i] = j;
            }
            ids[k] = j;
        }
        tri(part, ids[0], ids[1], ids[2]);
    }
    const eyeParts = buildEyes(A.eyes.map(e => ({ c: W(e.c), R: e.R, r: e.r * s })), p.seed);
    const mesh: Mesh = { parts: [...parts.filter(q => q.indices.length), ...eyeParts] };

    // The handle for clothing and hair.
    let grid: LazyGrid | null = null;
    const field = fieldOf(body);
    const hu = M.hu;
    const handle: FigureHandle = {
        params: p, measures: M, skeleton: sk, body, field, box, scale: s, lift,
        segments: Object.fromEntries(Object.entries(A.segments).map(([k, v]) => [k, scaledNode(v, s, lift)])) as Record<SegmentName, SdfNode>,
        head: { center: W(sk.pt("head", [0, M.eyeY + 0.022 * hu, -0.014 * hu])), R: sk.bones.get("head")!.R, radii: [0.074 * hu * s, 0.097 * hu * s, 0.097 * hu * s], eyeY: W(sk.pt("head", [0, M.eyeY, 0]))[1], hu: hu * s },
        collider: () => grid ?? (grid = new LazyGrid(body, [box[0] - 0.3, box[1] - 0.05, box[2] - 0.3, box[3] + 0.3, box[4] + 0.15, box[5] + 0.3], 0.008)),
        joint: (bone, at = 0) => { const b = sk.bones.get(bone)!; return W(sk.pt(bone, lerp3(b.head, b.tail, at))); },
        toWorld: (bone, q) => W(sk.pt(bone, q)),
        headPoint: (x, y, z) => W(sk.pt("head", [x * hu, M.eyeY + y * hu, z * hu])),
        headDir: (x, y, z) => norm(m3apply(sk.bones.get("head")!.R, [x, y, z])),
    };
    const out = { mesh, handle };
    cache.set(key, out);
    while (cache.size > 6) cache.delete(cache.keys().next().value as string);
    return out;
}

/** 0 at the feet, 1 at the head. */
const y01 = (y: number, b: Box) => (y - b[1]) / Math.max(1e-6, b[4] - b[1]);

// --- Eyes ----------------------------------------------------------------------------------------

/**
 * Each eye: a white sclera, a recessed iris annulus (uv carries its polar coordinates for the iris
 * pattern), a pupil, and a clear, glossy cornea bulging over them.
 */
function buildEyes(eyes: { c: Vec3; R: M3; r: number }[], seed: number): Part[] {
    const sclera = newPart("eyes"), iris = newPart("iris"), pupil = newPart("pupil"), cornea = newPart("cornea");
    const grid = (part: Part, rows: number[][], flip = false) => {
        for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j + 1 < rows[i].length; j++) {
            const a = rows[i][j], b = rows[i][j + 1], c = rows[i + 1][j + 1], d = rows[i + 1][j];
            if (flip) { tri(part, a, c, b); tri(part, a, d, c); } else { tri(part, a, b, c); tri(part, a, c, d); }
        }
    };
    for (const [k, e] of eyes.entries()) {
        // Straight ahead with a touch of convergence.
        const look = norm(m3apply(e.R, [(k === 0 ? -1 : 1) * 0.04 + (hash01(seed, 9, 2) - 0.5) * 0.02, -0.02, 1]));
        const right = norm(cross(m3apply(e.R, [0, 1, 0]), look)), up = cross(look, right);
        const toW = (lx: number, ly: number, lz: number): Vec3 => [e.c[0] + right[0] * lx + up[0] * ly + look[0] * lz, e.c[1] + right[1] * lx + up[1] * ly + look[1] * lz, e.c[2] + right[2] * lx + up[2] * ly + look[2] * lz];
        const dirW = (lx: number, ly: number, lz: number): Vec3 => norm([right[0] * lx + up[0] * ly + look[0] * lz, right[1] * lx + up[1] * ly + look[1] * lz, right[2] * lx + up[2] * ly + look[2] * lz]);
        const R = e.r, irisR = R * 0.48, pupilR = irisR * 0.36;
        const capCos = Math.sqrt(1 - (irisR / R) ** 2);
        const rings = 16, segs = 28;
        // Sclera: from the back of the eyeball to the iris rim; uv.y tints it pinker toward the corners.
        const rows: number[][] = [];
        for (let i = 0; i <= rings; i++) {
            const th = Math.PI - (Math.PI - Math.acos(capCos)) * (i / rings);
            const row: number[] = [];
            for (let j = 0; j <= segs; j++) {
                const ph = (j / segs) * Math.PI * 2;
                const d: Vec3 = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
                row.push(vertex(sclera, toW(d[0] * R, d[1] * R, d[2] * R), dirW(d[0], d[1], d[2]), [0, 0.3 * (1 - i / rings)]));
            }
            rows.push(row);
        }
        grid(sclera, rows);
        // Iris: an annulus recessed just behind the rim; uv = (angle, radius 0 at the pupil .. 1 at the rim).
        const zRim = R * capCos, zIris = zRim - R * 0.025;
        const irows: number[][] = [];
        for (let i = 0; i <= 5; i++) {
            const rr = irisR - (irisR - pupilR) * (i / 5);
            const z = zIris + (zRim - zIris) * (1 - i / 5) * 0.4;
            const row: number[] = [];
            for (let j = 0; j <= segs; j++) {
                const ph = (j / segs) * Math.PI * 2;
                row.push(vertex(iris, toW(Math.cos(ph) * rr, Math.sin(ph) * rr, z), dirW(Math.cos(ph) * 0.12, Math.sin(ph) * 0.12, 1), [j / segs, Math.min(0.999, (rr - pupilR) / (irisR - pupilR))]));
            }
            irows.push(row);
        }
        grid(iris, irows);
        // Pupil disc.
        const pc = vertex(pupil, toW(0, 0, zIris + 0.0001), dirW(0, 0, 1));
        const prow: number[] = [];
        for (let j = 0; j <= segs; j++) { const ph = (j / segs) * Math.PI * 2; prow.push(vertex(pupil, toW(Math.cos(ph) * pupilR * 1.02, Math.sin(ph) * pupilR * 1.02, zIris + 0.0001), dirW(0, 0, 1))); }
        for (let j = 0; j < segs; j++) tri(pupil, pc, prow[j], prow[j + 1]);
        // Cornea: a dome of a smaller sphere bulging past the eyeball over the iris.
        const cr = irisR * 1.35, cz = zRim + R * 0.2 - cr;
        const thMax = Math.asin(Math.min(0.999, (irisR * 1.08) / cr));
        const crows: number[][] = [];
        for (let i = 0; i <= 6; i++) {
            const th = thMax * (i / 6);
            const row: number[] = [];
            for (let j = 0; j <= segs; j++) {
                const ph = (j / segs) * Math.PI * 2;
                const d: Vec3 = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
                row.push(vertex(cornea, toW(d[0] * cr, d[1] * cr, cz + d[2] * cr), dirW(d[0], d[1], d[2])));
            }
            crows.push(row);
        }
        grid(cornea, crows, true);
    }
    return [sclera, iris, pupil, cornea].filter(q => q.indices.length);
}

function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
