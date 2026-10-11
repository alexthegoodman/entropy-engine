import type { ObjectDef } from "../mesha_object";

// What the wardens of the kingdoms below wear over Mesha's human (people.human), sized to its
// height: a deep hood open at the face, a mantle over the shoulders falling behind to the knees,
// a bronze mask with eye slits that glow with the river's light, a long tabard down the front
// with the river's emblem, bracers, a shoulder guard, and a belt hung with vials of river water.
// Model space as the human: facing +Z, soles on y = 0.
//
// Lathe arcs start on +X and run through -Z: the hood's gap faces +Z turned by -55 degrees about
// Y (a 290-degree sweep); the mantle (200 degrees) faces -Z turned by -10.

export const wardenGarbDef: ObjectDef = {
    id: "people.warden_garb",
    name: "Warden Garb",
    category: "People",
    tags: ["robe", "hood", "cloak", "mantle", "mask", "warrior", "warden", "fantasy", "underground", "priest", "monk", "mage", "tabard", "vials", "abyss"],
    description: "A warrior-priest's garb from the kingdoms below, sized to the human: deep hood, mantle, glowing-eyed bronze mask, tabard with the river's emblem, bracers, a shoulder guard and a belt of river-water vials.",
    featured: ["height", "mask", "mantleLength", "vials", "clothFinish", "trimFinish"],
    groups: [
        { id: "fit", label: "Fit" },
        { id: "pieces", label: "Pieces" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Wearer height", type: "number", default: 1.75, min: 1.5, max: 2.0, unit: "m", group: "fit" },
        { id: "hood", label: "Hood", type: "enum", default: "up", options: ["up", "down"], optionLabels: ["Up", "Down"], group: "pieces" },
        { id: "mask", label: "Mask", type: "bool", default: true, group: "pieces" },
        { id: "mantleLength", label: "Mantle length", type: "number", default: 0.95, min: 0.4, max: 1.3, group: "pieces", description: "How far down the back the mantle falls (1 to the knee)." },
        { id: "tabard", label: "Tabard", type: "bool", default: true, group: "pieces" },
        { id: "shoulderGuard", label: "Shoulder guard", type: "bool", default: true, group: "pieces" },
        { id: "vials", label: "Vials", type: "int", default: 4, min: 0, max: 8, group: "pieces" },
        { id: "clothFinish", label: "Cloth", type: "material", default: "cloth.indigo", materials: ["cloth", "fabric"], group: "materials" },
        { id: "innerFinish", label: "Tabard", type: "material", default: "cloth.saffron", materials: ["cloth", "fabric"], group: "materials", visibleIf: "=tabard" },
        { id: "trimFinish", label: "Bronze", type: "material", default: "metal.bronze", materials: ["metal.bronze", "metal.verdigris", "metal.brass", "metal.gold"], group: "materials" },
        { id: "glowFinish", label: "River light", type: "material", default: "glow.river", materials: ["glow.river", "glow.riverViolet", "glow.riverGold", "glow.cyan"], group: "materials" },
    ],
    derived: {
        k: "=height / 1.7",
        headY: "=1.62 * height / 1.7",
        mantleBottom: "=1.42 * height / 1.7 - mantleLength * 0.92 * height / 1.7",
    },
    regions: {
        cloth: { label: "Cloth", material: "=clothFinish" },
        inner: { label: "Tabard", material: "=innerFinish" },
        trim: { label: "Bronze", material: "=trimFinish" },
        glow: { label: "River light", material: "=glowFinish" },
        leather: { label: "Leather", material: "leather.brown" },
    },
    presets: [
        { name: "Warden of the river", values: {} },
        { name: "Saffron adept", values: { clothFinish: "cloth.saffron", innerFinish: "cloth.wine", trimFinish: "metal.gold", glowFinish: "glow.riverGold" } },
        { name: "Ash sentinel", values: { clothFinish: "cloth.ash", innerFinish: "cloth.indigo", trimFinish: "metal.verdigris", mantleLength: 1.25, vials: 6 } },
        { name: "Unmasked pilgrim", values: { mask: false, hood: "down", shoulderGuard: false, vials: 2, clothFinish: "cloth.wine", innerFinish: "cloth.ash" } },
    ],
    nodes: [
        // --- The hood: a deep cowl round the head, open at the face (down: a roll at the neck). ---
        {
            id: "cowl", type: "mesh.lathe", when: "=hood == 'up'", sweep: 290, segments: 22, smoothAngle: 70, region: "cloth",
            profile: [["=0.17 * k", "=-0.17 * k"], ["=0.155 * k", "=-0.06 * k"], ["=0.148 * k", "=0.04 * k"], ["=0.125 * k", "=0.12 * k"], ["=0.07 * k", "=0.175 * k"], ["=0.02 * k", "=0.19 * k"]],
            scale: [1, 1, 1.15], rotate: [0, -55, 0], at: [0, "=headY", "=-0.02 * k"],
        },
        { id: "hoodRoll", type: "mesh.torus", when: "=hood == 'down'", major: "=0.12 * k", minor: "=0.045 * k", segments: 20, sides: 8, scale: [1.2, 1, 1.1], at: [0, "=1.45 * k", "=-0.03 * k"], region: "cloth" },
        // --- The mantle over the shoulders, falling behind. ---
        {
            id: "mantle", type: "mesh.lathe", sweep: 200, segments: 18, smoothAngle: 70, region: "cloth",
            profile: [["=0.36 * k", "=mantleBottom - 1.42 * k"], ["=0.3 * k", "=(mantleBottom - 1.42 * k) * 0.5"], ["=0.26 * k", "=-0.04 * k"], ["=0.2 * k", "=0.03 * k"], ["=0.1 * k", "=0.06 * k"]],
            scale: [1, 1, 0.72], rotate: [0, -10, 0], at: [0, "=1.42 * k", "=-0.03 * k"],
        },
        // --- The mask. ---
        {
            id: "maskPlate", type: "mesh.lathe", when: "=mask", sweep: 120, segments: 12, smoothAngle: 60, region: "trim",
            profile: [["=0.085 * k", "=-0.085 * k"], ["=0.105 * k", "=-0.02 * k"], ["=0.108 * k", "=0.03 * k"], ["=0.095 * k", "=0.08 * k"]],
            scale: [1, 1, 1.05], rotate: [0, -150, 0], at: [0, "=headY - 0.02 * k", "=0.0 * k"],
        },
        { id: "eyeSlits", type: "mesh.box", repeat: 2, when: "=mask", size: ["=0.035 * k", "=0.008 * k", "=0.01 * k"], rotate: [0, "=index == 0 ? 18 : -18", 0], at: ["=(index == 0 ? 1 : -1) * 0.035 * k", "=headY + 0.01 * k", "=0.108 * k"], region: "glow" },
        { id: "browCrest", type: "mesh.box", when: "=mask", size: ["=0.012 * k", "=0.05 * k", "=0.012 * k"], at: [0, "=headY + 0.06 * k", "=0.1 * k"], region: "glow" },
        // --- The tabard down the front, its emblem (a ring and a drop: the river and its source). ---
        { id: "tabardPanel", type: "mesh.box", when: "=tabard", size: ["=0.2 * k", "=0.78 * k", "=0.012 * k"], radius: "=0.004 * k", divisions: [1, 4, 1], at: [0, "=1.0 * k", "=0.15 * k"], rotate: [-4, 0, 0], region: "inner" },
        { id: "emblemRing", type: "mesh.torus", when: "=tabard", major: "=0.045 * k", minor: "=0.007 * k", segments: 16, sides: 4, rotate: [90, 0, 0], at: [0, "=1.24 * k", "=0.165 * k"], region: "glow" },
        { id: "emblemDrop", type: "mesh.sphere", when: "=tabard", radius: "=0.015 * k", segments: 8, rings: 6, scale: [1, 1.5, 0.6], at: [0, "=1.24 * k", "=0.168 * k"], region: "trim" },
        // --- Belt and vials. ---
        { id: "belt", type: "mesh.torus", major: "=0.16 * k", minor: "=0.02 * k", segments: 22, sides: 6, scale: [1.08, 1, 0.95], at: [0, "=0.98 * k", "=0.005 * k"], region: "leather" },
        { id: "buckle", type: "mesh.cylinder", radius: "=0.035 * k", height: "=0.015 * k", segments: 12, rotate: [90, 0, 0], at: [0, "=0.98 * k", "=0.175 * k"], region: "trim" },
        {
            id: "vialGlass", type: "mesh.cylinder", repeat: "=vials", when: "=vials > 0", radius: "=0.014 * k", height: "=0.075 * k", segments: 8,
            at: ["=sin(rad(100 + index * 160 / max(1, vials - 1))) * 0.185 * k", "=0.9 * k", "=cos(rad(100 + index * 160 / max(1, vials - 1))) * 0.175 * k"], region: "glow",
        },
        {
            id: "vialCaps", type: "mesh.cylinder", repeat: "=vials", when: "=vials > 0", radius: "=0.016 * k", height: "=0.015 * k", segments: 8,
            at: ["=sin(rad(100 + index * 160 / max(1, vials - 1))) * 0.185 * k", "=0.975 * k", "=cos(rad(100 + index * 160 / max(1, vials - 1))) * 0.175 * k"], region: "trim",
        },
        // --- Bracers and the shoulder guard. ---
        { id: "bracers", type: "mesh.cylinder", repeat: 2, radius: "=0.042 * k", height: "=0.15 * k", segments: 10, bevel: "=0.006 * k", at: ["=(index == 0 ? 1 : -1) * 0.255 * k", "=0.92 * k", "=0.0 * k"], region: "trim" },
        {
            id: "guard", type: "mesh.lathe", when: "=shoulderGuard", segments: 12, smoothAngle: 70, region: "trim",
            profile: [["=0.085 * k", "=-0.04 * k"], ["=0.08 * k", "=0.015 * k"], ["=0.05 * k", "=0.055 * k"], [0, "=0.07 * k"]],
            scale: [1, 1, 1.3], rotate: [0, 0, 30], at: ["=-0.215 * k", "=1.41 * k", "=-0.01 * k"],
        },
    ],
    limits: { maxSize: 2.2, minSize: 0.3, maxTriangles: 20000, floor: false },
};

export default wardenGarbDef;
