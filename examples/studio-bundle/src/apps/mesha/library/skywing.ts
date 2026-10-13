import type { ObjectDef } from "../mesha_object";

// A flying creature of the deep (The Abyss's skywing, a "vaelith" to the kingdoms below): a long
// neck and a horned head, a lean body on two hind legs, a long tail ending in a glowing fin, and
// two broad membrane wings on bony arms and three long fingers - a bat's hand at a dragon's scale.
// Bioluminescent spots run down its back; its eyes hold the river's light. Nose toward +Z, its
// hind feet on the ground at the origin, the wings spread level (gliding). Its left side is +X.
//
//                      horns
//                 ___ /
//          snout <___)  neck                 ._ finger tips
//                     \____    shoulder  ___/  \
//                          (  body  )===<  wing  >     (region wingL / wingR: games flap them
//                     legs  ||    \___tail____/fin      about the shoulder, skywingShoulder())
//
// Each wing's membrane and its bones have their own regions (wingL, wingBoneL, wingR, wingBoneR)
// so a game can split them off and turn them; the rest is one rigid body. `wounded` adds a broken
// slug-bolt in the left shoulder and a glowing wound; `saddle` the expedition webbing a rider
// straps on.

/** Where the wing roots turn (left wing; the right is mirrored on x), for a creature of `length`. */
export function skywingShoulder(length: number): [number, number, number] {
    const s = length / 9;
    return [0.5 * s, 2.18 * s, 0.4 * s];
}

/** Height of the saddle's seat above the feet (for placing a rider). */
export const skywingSeat = (length: number): number => (length / 9) * 2.5;

export const skywingDef: ObjectDef = {
    id: "creature.skywing",
    name: "Skywing",
    category: "Nature",
    tags: ["creature", "dragon", "wyvern", "flying", "mount", "beast", "animal", "fantasy", "wings", "abyss", "monster", "glow"],
    description: "A flying creature of the deep: long neck and horned head, lean body on two hind legs, membrane wings on three long fingers, a long tail with a glowing fin, and bioluminescent spots. Optional wound and rider's saddle.",
    featured: ["length", "span", "neck", "hideFinish", "membraneFinish", "glowFinish", "saddle"],
    groups: [{ id: "body", label: "Body" }, { id: "wings", label: "Wings" }, { id: "story", label: "Condition" }, { id: "materials", label: "Materials" }],
    params: [
        { id: "length", label: "Length", type: "number", default: 9, min: 4, max: 14, unit: "m", group: "body", description: "Body scale: nose to the base of the tail fin is about this long." },
        { id: "neck", label: "Neck", type: "number", default: 1, min: 0.6, max: 1.5, group: "body", description: "Neck length relative to the body." },
        { id: "tail", label: "Tail", type: "number", default: 1, min: 0.6, max: 1.6, group: "body" },
        { id: "bulk", label: "Bulk", type: "number", default: 1, min: 0.75, max: 1.35, group: "body", description: "Body girth." },
        { id: "horns", label: "Horns", type: "enum", default: "swept", options: ["swept", "none"], optionLabels: ["Swept back", "None"], group: "body" },
        { id: "spots", label: "Glow spots", type: "int", default: 9, min: 0, max: 16, group: "body", description: "Bioluminescent spots along the back." },
        { id: "span", label: "Wingspan", type: "number", default: 1.7, min: 1.1, max: 2.1, group: "wings", description: "Tip to tip, relative to the length." },
        { id: "fingers", label: "Fingers", type: "int", default: 3, min: 2, max: 3, group: "wings" },
        { id: "wounded", label: "Wounded", type: "bool", default: false, group: "story", description: "A broken slug-bolt in the left shoulder and a glowing wound." },
        { id: "saddle", label: "Saddle", type: "bool", default: false, group: "story", description: "Expedition webbing strapped on as a rider's saddle." },
        { id: "hideFinish", label: "Hide", type: "material", default: "scale.violet", materials: ["scale", "stone", "leather", "composite", "paint.plum", "paint.teal", "paint.black"], group: "materials" },
        { id: "bellyFinish", label: "Throat and jaw", type: "material", default: "scale.pale", materials: ["scale", "stone", "leather", "ceramic"], group: "materials" },
        { id: "membraneFinish", label: "Wing membrane", type: "material", default: "cloth.indigo", materials: ["cloth", "leather", "glass.violet", "paint.plum"], group: "materials" },
        { id: "glowFinish", label: "Glow", type: "material", default: "glow.river", materials: ["glow"], group: "materials" },
        { id: "hornFinish", label: "Horns and claws", type: "material", default: "stone.dark", materials: ["stone", "ceramic", "metal.bronze", "metal.gold"], group: "materials" },
        { id: "saddleFinish", label: "Saddle", type: "material", default: "fabric.olive", materials: ["fabric", "polymer", "leather"], group: "materials", visibleIf: "=saddle" },
    ],
    derived: {
        s: "=length / 9",
        bw: "=0.74 * bulk * length / 9",
        bh: "=0.76 * bulk * length / 9",
        bodyY: "=1.78 * length / 9",
        nl: "=neck * 1.7 * length / 9",
        neckY: "=2.05 * length / 9",
        neckZ: "=1.2 * length / 9",
        hy: "=2.05 * length / 9 + neck * 1.7 * length / 9 * 0.82",
        hz: "=1.2 * length / 9 + neck * 1.7 * length / 9 * 0.95",
        tl: "=tail * 3.6 * length / 9",
        // The wing: shoulder (sx, wy), half span, and the points of the hand along it.
        sx: "=0.5 * length / 9",
        wy: "=2.18 * length / 9",
        hs: "=span * length / 2",
        ex: "=0.5 * length / 9 + (span * length / 2 - 0.5 * length / 9) * 0.32",
        wx: "=0.5 * length / 9 + (span * length / 2 - 0.5 * length / 9) * 0.52",
        f2x: "=0.5 * length / 9 + (span * length / 2 - 0.5 * length / 9) * 0.84",
        f3x: "=0.5 * length / 9 + (span * length / 2 - 0.5 * length / 9) * 0.6",
    },
    regions: {
        hide: { label: "Hide", material: "=hideFinish" },
        belly: { label: "Throat and jaw", material: "=bellyFinish" },
        wingL: { label: "Left wing membrane", material: "=membraneFinish" },
        wingR: { label: "Right wing membrane", material: "=membraneFinish" },
        wingBoneL: { label: "Left wing arm", material: "=hideFinish" },
        wingBoneR: { label: "Right wing arm", material: "=hideFinish" },
        glow: { label: "Glow", material: "=glowFinish" },
        eye: { label: "Eyes", material: "=glowFinish" },
        horn: { label: "Horns and claws", material: "=hornFinish" },
        saddle: { label: "Saddle", material: "=saddleFinish" },
        buckle: { label: "Buckles", material: "metal.gunmetal" },
        wound: { label: "Wound", material: "glow.red" },
        shaft: { label: "Slug-bolt", material: "metal.gunmetal" },
    },
    presets: [
        { name: "River skywing", values: {} },
        { name: "Wounded skywing", values: { wounded: true } },
        { name: "Saddled skywing", values: { saddle: true } },
        { name: "Hatchling", values: { length: 4.5, neck: 1.2, span: 1.4, spots: 5, horns: "none" } },
        { name: "Elder of the deep", values: { length: 13, bulk: 1.25, span: 2, hideFinish: "stone.slate", membraneFinish: "glass.violet", glowFinish: "glow.riverGold", hornFinish: "metal.gold", spots: 14 } },
        { name: "Ash wing", values: { hideFinish: "stone.dark", membraneFinish: "cloth.wine", glowFinish: "glow.amber", spots: 6 } },
    ],
    nodes: [
        // --- Body: a revolved profile laid along Z (rotate x 90 takes +Y to +Z), squashed. ---
        {
            id: "body", type: "mesh.lathe", segments: 28, smoothAngle: 70, region: "hide",
            profile: [["=0", "=-1.4 * s"], ["=0.45", "=-1.32 * s"], ["=0.8", "=-0.95 * s"], ["=1", "=-0.25 * s"], ["=1", "=0.45 * s"], ["=0.86", "=1.05 * s"], ["=0.55", "=1.45 * s"], ["=0", "=1.6 * s"]],
            rotate: [90, 0, 0], scale: ["=bw", 1, "=bh"], at: [0, "=bodyY", 0],
        },
        // A keel of paler hide along the chest.
        {
            id: "chest", type: "mesh.sphere", radius: 1, segments: 16, rings: 10, region: "belly",
            scale: ["=bw * 0.62", "=bh * 0.5", "=s * 0.9"], at: [0, "=bodyY - bh * 0.42", "=s * 0.65"],
        },
        // --- Neck and head. ---
        {
            id: "neckPath", type: "path.points", output: false, smooth: 5,
            points: [[0, "=neckY", "=neckZ - s * 0.2"], [0, "=neckY + nl * 0.45", "=neckZ + nl * 0.4"], [0, "=hy", "=hz"]],
        },
        { id: "neckTube", type: "mesh.sweep", path: "@neckPath", radius: "=s * 0.36 * bulk", sides: 14, taper: 0.62, region: "hide" },
        {
            id: "head", type: "mesh.lathe", segments: 24, smoothAngle: 75, region: "hide",
            profile: [["=0", "=-0.32 * s"], ["=0.55", "=-0.29 * s"], ["=0.85", "=-0.18 * s"], ["=1", "=0.05 * s"], ["=0.94", "=0.25 * s"], ["=0.8", "=0.45 * s"], ["=0.58", "=0.72 * s"], ["=0.4", "=0.95 * s"], ["=0.26", "=1.1 * s"], ["=0", "=1.2 * s"]],
            rotate: [102, 0, 0], scale: ["=s * 0.34", 1, "=s * 0.28"], at: [0, "=hy + s * 0.04", "=hz - s * 0.05"],
        },
        { id: "jaw", type: "mesh.box", size: ["=s * 0.36", "=s * 0.07", "=s * 0.8"], radius: "=s * 0.03", rotate: [16, 0, 0], at: [0, "=hy - s * 0.2", "=hz + s * 0.42"], region: "belly" },
        { id: "eyes", type: "mesh.sphere", repeat: 2, radius: "=s * 0.065", segments: 10, rings: 6, at: ["=(index == 0 ? 1 : -1) * s * 0.21", "=hy + s * 0.1", "=hz + s * 0.26"], region: "eye" },
        {
            id: "hornsNode", type: "mesh.sweep", repeat: 2, when: "=horns == 'swept'", radius: "=s * 0.075", sides: 8, taper: 0.08, region: "horn",
            path: [["=(index == 0 ? 1 : -1) * s * 0.15", "=hy + s * 0.16", "=hz - s * 0.05"], ["=(index == 0 ? 1 : -1) * s * 0.3", "=hy + s * 0.36", "=hz - s * 0.5"], ["=(index == 0 ? 1 : -1) * s * 0.36", "=hy + s * 0.42", "=hz - s * 0.98"]],
        },
        // --- Tail and its fin. ---
        {
            id: "tailPath", type: "path.points", output: false, smooth: 5,
            points: [[0, "=bodyY + s * 0.05", "=-1.15 * s"], [0, "=bodyY - s * 0.15", "=-1.15 * s - tl * 0.35"], [0, "=bodyY - s * 0.45", "=-1.15 * s - tl * 0.72"], [0, "=bodyY - s * 0.55", "=-1.15 * s - tl"]],
        },
        { id: "tailTube", type: "mesh.sweep", path: "@tailPath", radius: "=s * 0.42 * bulk", sides: 14, taper: 0.12, region: "hide" },
        {
            id: "fin", type: "mesh.extrude", height: "=s * 0.03", region: "glow",
            outline: [[0, "=s * 0.35"], ["=s * 0.55", "=-s * 0.05"], [0, "=-s * 0.95"], ["=-s * 0.55", "=-s * 0.05"]],
            at: [0, "=bodyY - s * 0.57", "=-1.15 * s - tl"],
        },
        // --- Glow spots down the back (and flanks, alternately). ---
        {
            id: "spotsNode", type: "mesh.sphere", repeat: "=spots", radius: "=s * (0.075 - t * 0.03)", segments: 8, rings: 5, region: "glow",
            at: ["=(index % 3 == 0 ? 0 : (index % 3 == 1 ? 1 : -1) * s * 0.36 * (1 - t * 0.6))", "=bodyY + bh * (index % 3 == 0 ? 0.98 : 0.8) - t * s * 0.55", "=s * 1.1 - t * (2.25 * s + tl * 0.55)"],
        },
        // --- Hind legs: thigh, shin, foot, three claws each. ---
        {
            id: "legs", type: "mesh.sweep", repeat: 2, radius: "=s * 0.25 * bulk", sides: 12, taper: 0.38, region: "hide",
            path: [["=(index == 0 ? 1 : -1) * s * 0.42", "=bodyY - s * 0.15", "=-0.65 * s"], ["=(index == 0 ? 1 : -1) * s * 0.52", "=s * 0.95", "=-0.2 * s"], ["=(index == 0 ? 1 : -1) * s * 0.5", "=s * 0.36", "=-0.72 * s"], ["=(index == 0 ? 1 : -1) * s * 0.5", "=s * 0.1", "=-0.5 * s"]],
        },
        {
            id: "claws", type: "mesh.cone", repeat: 6, bottomRadius: "=s * 0.055", topRadius: 0, height: "=s * 0.32", segments: 6, region: "horn",
            rotate: [80, "=(index % 3 - 1) * 22", 0], at: ["=(index < 3 ? 1 : -1) * s * 0.5 + (index % 3 - 1) * s * 0.08", "=s * 0.06", "=-0.48 * s"],
        },
        // --- Wings: the membrane on the arm and fingers, mirrored for the right. ---
        {
            id: "membrane", type: "mesh.extrude", repeat: 2, height: "=s * 0.035", region: "=index == 0 ? 'wingL' : 'wingR'",
            outline: [
                ["=sx", "=s * 0.85"], ["=ex", "=s * 1.05"], ["=wx", "=s * 0.92"], ["=hs", "=s * 0.15"],
                ["=(hs + f2x) * 0.5 - (hs - sx) * 0.06", "=s * -0.62"], ["=f2x", "=-s * 1.25"],
                ["=fingers == 3 ? (f2x + f3x) * 0.5 - (hs - sx) * 0.05 : (f2x + sx) * 0.5", "=fingers == 3 ? -s * 1.5 : -s * 1.45"],
                ["=fingers == 3 ? f3x : (f2x + sx) * 0.5 - (hs - sx) * 0.04", "=fingers == 3 ? -s * 2.05 : -s * 1.5"],
                ["=fingers == 3 ? (f3x + sx) * 0.5 : sx + (f2x - sx) * 0.25", "=-s * 1.45"], ["=sx", "=-s * 0.95"],
            ],
            scale: ["=index == 0 ? 1 : -1", 1, 1], at: [0, "=wy - s * 0.02", 0],
        },
        {
            id: "arm", type: "mesh.sweep", repeat: 2, radius: "=s * 0.11", sides: 8, taper: 0.55, region: "=index == 0 ? 'wingBoneL' : 'wingBoneR'",
            path: [["=sx * 0.6", "=wy", "=s * 0.45"], ["=ex", "=wy + s * 0.05", "=s * 1.05"], ["=wx", "=wy + s * 0.03", "=s * 0.9"]],
            scale: ["=index == 0 ? 1 : -1", 1, 1],
        },
        {
            id: "fingerBones", type: "mesh.sweep", repeat: "=fingers * 2", radius: "=s * 0.055", sides: 6, taper: 0.25, region: "=index < fingers ? 'wingBoneL' : 'wingBoneR'",
            path: [["=wx", "=wy + s * 0.04", "=s * 0.9"], ["=index % fingers == 0 ? hs : (index % fingers == 1 ? f2x : f3x)", "=wy + s * 0.03", "=index % fingers == 0 ? s * 0.15 : (index % fingers == 1 ? -s * 1.25 : -s * 2.05)"]],
            scale: ["=index < fingers ? 1 : -1", 1, 1],
        },
        // The thumb claw at each wrist.
        {
            id: "thumbs", type: "mesh.cone", repeat: 2, bottomRadius: "=s * 0.05", topRadius: 0, height: "=s * 0.28", segments: 6, region: "=index == 0 ? 'wingBoneL' : 'wingBoneR'",
            rotate: [70, 0, 0], at: ["=(index == 0 ? 1 : -1) * wx", "=wy + s * 0.05", "=s * 0.95"],
        },
        // --- The wound: a broken slug-bolt in the left shoulder, glowing. ---
        { id: "woundGlow", type: "mesh.sphere", when: "=wounded", radius: "=s * 0.16", segments: 10, rings: 6, scale: [1, 0.6, 1], at: ["=s * 0.5", "=bodyY + bh * 0.62", "=s * 0.42"], region: "wound" },
        { id: "bolt", type: "mesh.cylinder", when: "=wounded", radius: "=s * 0.035", height: "=s * 0.75", segments: 8, rotate: [-28, 0, -38], at: ["=s * 0.5", "=bodyY + bh * 0.62", "=s * 0.42"], region: "shaft" },
        // --- The saddle: a pad on the back behind the wings, straps round the body. ---
        { id: "seat", type: "mesh.box", when: "=saddle", size: ["=bw * 0.95", "=s * 0.14", "=s * 0.9"], radius: "=s * 0.05", at: [0, "=bodyY + bh * 0.93", "=-s * 0.1"], region: "saddle" },
        { id: "cantle", type: "mesh.box", when: "=saddle", size: ["=bw * 0.8", "=s * 0.2", "=s * 0.1"], radius: "=s * 0.04", at: [0, "=bodyY + bh * 1.02", "=-s * 0.52"], region: "saddle" },
        { id: "grips", type: "mesh.torus", when: "=saddle", repeat: 2, major: "=s * 0.08", minor: "=s * 0.02", segments: 12, sides: 6, rotate: [0, 0, 90], at: ["=(index == 0 ? 1 : -1) * bw * 0.3", "=bodyY + bh * 1.08", "=s * 0.3"], region: "buckle" },
        { id: "straps", type: "mesh.torus", when: "=saddle", repeat: 2, major: 1, minor: 0.04, segments: 24, sides: 6, scale: ["=bw * 1.02", 1, "=bh * 1.02"], rotate: [90, 0, 0], at: [0, "=bodyY", "=index == 0 ? s * 0.25 : -s * 0.45"], region: "saddle" },
    ],
    limits: { maxSize: 32, minSize: 3, maxTriangles: 16000 },
};

export default skywingDef;
