import type { ObjectDef } from "../mesha_object";

// Weapons of the war below and above.
//
// Coil Rifle: the surface's magnetic rifle (rifle, carbine or pistol). The hand holds the grip at
// the origin; the barrel runs along +Z through glowing accelerator coils, a stock behind along -Z.
//
// Melee Weapon: a surface monoblade (a short sword with a glowing edge), a warden's glaive (a
// crescent blade on a long shaft with a crystal at the socket) or a warden's staff (a bronze cage
// holding a river crystal). The hand holds it at the origin; it points along +Y.

export const coilRifleDef: ObjectDef = {
    id: "equipment.coil_rifle",
    name: "Coil Rifle",
    category: "Mechanical",
    tags: ["gun", "rifle", "weapon", "carbine", "pistol", "coilgun", "railgun", "sci-fi", "military", "firearm", "blaster"],
    description: "A magnetic coil rifle, carbine or pistol: receiver, barrel through glowing accelerator coils, stock, grip, magazine and a holographic sight. Held at the grip (origin), firing along +Z.",
    featured: ["kind", "coils", "sight", "bodyFinish", "glowFinish"],
    groups: [{ id: "shape", label: "Shape" }, { id: "materials", label: "Materials" }],
    params: [
        { id: "kind", label: "Kind", type: "enum", default: "rifle", options: ["rifle", "carbine", "pistol"], optionLabels: ["Rifle", "Carbine", "Pistol"], group: "shape" },
        { id: "coils", label: "Coils", type: "int", default: 5, min: 2, max: 9, group: "shape" },
        { id: "sight", label: "Holo sight", type: "bool", default: true, group: "shape" },
        { id: "stock", label: "Stock", type: "bool", default: true, group: "shape", visibleIf: "=kind != 'pistol'" },
        { id: "bodyFinish", label: "Body", type: "material", default: "composite.black", materials: ["composite", "polymer", "metal.gunmetal", "paint"], group: "materials" },
        { id: "metalFinish", label: "Barrel", type: "material", default: "metal.gunmetal", materials: ["metal"], group: "materials" },
        { id: "glowFinish", label: "Coils", type: "material", default: "glow.cyan", materials: ["glow"], group: "materials" },
    ],
    derived: {
        len: "=kind == 'rifle' ? 0.62 : kind == 'carbine' ? 0.46 : 0.17",
        rh: "=kind == 'pistol' ? 0.04 : 0.065",
        long: "=kind != 'pistol'",
    },
    regions: {
        body: { label: "Body", material: "=bodyFinish" },
        metal: { label: "Barrel", material: "=metalFinish" },
        glow: { label: "Coils", material: "=glowFinish" },
        glass: { label: "Sight glass", material: "glass.tinted" },
    },
    presets: [
        { name: "Coil rifle", values: {} },
        { name: "Carbine", values: { kind: "carbine", coils: 4 } },
        { name: "Sidearm", values: { kind: "pistol", coils: 3, sight: false } },
        { name: "Desert rifle", values: { bodyFinish: "polymer.tan", glowFinish: "glow.amber" } },
    ],
    nodes: [
        { id: "receiver", type: "mesh.box", size: ["=long ? 0.05 : 0.034", "=rh", "=long ? len * 0.42 : 0.15"], radius: 0.008, at: [0, "=rh * 0.5 + 0.035", "=long ? len * 0.12 : 0.03"], region: "body" },
        { id: "barrel", type: "mesh.cylinder", radius: "=long ? 0.011 : 0.009", height: "=long ? len * 0.62 : 0.1", segments: 10, rotate: [90, 0, 0], at: [0, "=rh * 0.62 + 0.035", "=long ? len * 0.3 : 0.1"], region: "metal" },
        {
            id: "coilRings", type: "mesh.torus", repeat: "=coils", major: "=long ? 0.024 : 0.017", minor: "=long ? 0.007 : 0.005", segments: 12, sides: 5, rotate: [90, 0, 0],
            at: [0, "=rh * 0.62 + 0.035", "=(long ? len * 0.36 : 0.11) + index * (long ? len * 0.5 : 0.07) / max(1, coils - 1)"], region: "glow",
        },
        { id: "shroud", type: "mesh.box", when: "=long", size: [0.06, 0.022, "=len * 0.5"], radius: 0.006, at: [0, "=rh + 0.05", "=len * 0.6"], region: "body" },
        { id: "muzzle", type: "mesh.cylinder", radius: "=long ? 0.02 : 0.014", height: 0.04, segments: 10, rotate: [90, 0, 0], at: [0, "=rh * 0.62 + 0.035", "=long ? len * 0.92 : 0.2"], region: "metal" },
        { id: "grip", type: "mesh.box", size: [0.03, 0.11, 0.04], radius: 0.008, rotate: [-16, 0, 0], at: [0, -0.015, -0.005], region: "body" },
        { id: "magazine", type: "mesh.box", when: "=long", size: [0.032, 0.12, 0.05], radius: 0.006, rotate: [8, 0, 0], at: [0, -0.01, "=len * 0.16"], region: "body" },
        { id: "magGlow", type: "mesh.box", when: "=long", size: [0.034, 0.05, 0.006], at: [0, -0.02, "=len * 0.16 + 0.026"], region: "glow" },
        { id: "stockBar", type: "mesh.box", when: "=long && stock", size: [0.035, 0.035, "=len * 0.4"], radius: 0.008, rotate: [-4, 0, 0], at: [0, "=rh * 0.6 + 0.02", "=-len * 0.22"], region: "body" },
        { id: "stockPad", type: "mesh.box", when: "=long && stock", size: [0.04, 0.11, 0.03], radius: 0.008, at: [0, "=rh * 0.35", "=-len * 0.43"], region: "body" },
        { id: "sightBase", type: "mesh.box", when: "=sight", size: [0.03, 0.025, 0.06], radius: 0.004, at: [0, "=rh + 0.06", "=long ? len * 0.08 : 0.0"], region: "body" },
        { id: "sightGlass", type: "mesh.box", when: "=sight", size: [0.026, 0.03, 0.004], at: [0, "=rh + 0.085", "=long ? len * 0.08 + 0.02 : 0.02"], region: "glass" },
        { id: "sightDot", type: "mesh.box", when: "=sight", size: [0.004, 0.004, 0.004], at: [0, "=rh + 0.085", "=long ? len * 0.08 + 0.024 : 0.024"], region: "glow" },
    ],
    limits: { maxSize: 1.2, minSize: 0.1, maxTriangles: 8000, floor: false },
};

export const meleeWeaponDef: ObjectDef = {
    id: "equipment.melee_weapon",
    name: "Melee Weapon",
    category: "Mechanical",
    tags: ["sword", "blade", "glaive", "staff", "spear", "polearm", "weapon", "melee", "fantasy", "monoblade", "crystal", "magic"],
    description: "A surface monoblade with a glowing edge, a warden's glaive (crescent blade, long shaft, crystal socket) or a warden's staff (a bronze cage around a river crystal). Held at the origin, pointing along +Y.",
    featured: ["kind", "length", "bladeFinish", "glowFinish"],
    groups: [{ id: "shape", label: "Shape" }, { id: "materials", label: "Materials" }],
    params: [
        { id: "kind", label: "Kind", type: "enum", default: "glaive", options: ["monoblade", "glaive", "staff"], optionLabels: ["Monoblade", "Glaive", "Staff"], group: "shape" },
        { id: "length", label: "Length", type: "number", default: 1, min: 0.8, max: 1.25, group: "shape", description: "Relative to the kind's own length." },
        { id: "bladeFinish", label: "Blade", type: "material", default: "metal.blade", materials: ["metal"], group: "materials" },
        { id: "shaftFinish", label: "Grip and shaft", type: "material", default: "wood.ebony", materials: ["wood", "polymer", "composite", "leather"], group: "materials" },
        { id: "trimFinish", label: "Fittings", type: "material", default: "metal.bronze", materials: ["metal"], group: "materials" },
        { id: "glowFinish", label: "Glow", type: "material", default: "glow.river", materials: ["glow"], group: "materials" },
    ],
    derived: {
        mono: "=kind == 'monoblade'", glaive: "=kind == 'glaive'", staff: "=kind == 'staff'",
        shaft: "=(kind == 'monoblade' ? 0.18 : kind == 'glaive' ? 1.55 : 1.6) * length",
        below: "=(kind == 'monoblade' ? 0.06 : 0.45) * length",
    },
    regions: {
        blade: { label: "Blade", material: "=bladeFinish" },
        shaft: { label: "Grip and shaft", material: "=shaftFinish" },
        trim: { label: "Fittings", material: "=trimFinish" },
        glow: { label: "Glow", material: "=glowFinish" },
    },
    presets: [
        { name: "Warden glaive", values: {} },
        { name: "River staff", values: { kind: "staff", glowFinish: "glow.riverViolet", trimFinish: "metal.verdigris" } },
        { name: "Monoblade", values: { kind: "monoblade", shaftFinish: "polymer.black", trimFinish: "metal.gunmetal", glowFinish: "glow.cyan" } },
        { name: "Golden glaive", values: { trimFinish: "metal.gold", glowFinish: "glow.riverGold", length: 1.15 } },
    ],
    nodes: [
        { id: "grip", type: "mesh.cylinder", radius: "=mono ? 0.017 : 0.019", height: "=shaft + below", segments: 10, at: [0, "=-below", 0], region: "shaft" },
        { id: "pommel", type: "mesh.sphere", radius: "=mono ? 0.024 : 0.03", segments: 10, rings: 6, at: [0, "=-below", 0], region: "trim" },
        // Monoblade.
        { id: "guard", type: "mesh.box", when: "=mono", size: [0.1, 0.02, 0.035], radius: 0.006, at: [0, "=shaft - below + 0.04", 0], region: "trim" },
        {
            id: "monoBlade", type: "mesh.extrude", when: "=mono", height: 0.008, bevel: 0.002, region: "blade",
            outline: [[-0.022, 0], [0.022, 0], [0.018, "=0.48 * length"], [0, "=0.56 * length"], [-0.02, "=0.47 * length"]],
            rotate: [90, 0, 0], at: [0, "=shaft - below + 0.05", 0.004],
        },
        { id: "monoEdge", type: "mesh.box", when: "=mono", size: [0.003, "=0.46 * length", 0.01], at: [0.021, "=shaft - below + 0.05 + 0.24 * length", 0], region: "glow" },
        // Glaive: socket, crystal, crescent blade.
        { id: "socket", type: "mesh.cylinder", when: "=glaive", radius: 0.03, height: 0.14, segments: 10, bevel: 0.01, at: [0, "=shaft - 0.1", 0], region: "trim" },
        { id: "socketCrystal", type: "mesh.icosphere", when: "=glaive || staff", radius: "=glaive ? 0.035 : 0.075", subdivisions: 0, scale: [0.8, 1.6, 0.8], at: [0, "=glaive ? shaft + 0.06 : shaft + 0.12", 0], region: "glow" },
        {
            id: "crescent", type: "mesh.extrude", when: "=glaive", height: 0.012, bevel: 0.003, region: "blade",
            outline: [[0.0, -0.04], [0.09, 0.02], [0.17, 0.16], [0.19, 0.34], [0.12, 0.5], [0.03, 0.58], [0.08, 0.42], [0.1, 0.25], [0.06, 0.1], [0.0, 0.05]],
            rotate: [90, 0, 0], at: [0.01, "=shaft - 0.02", 0.006],
        },
        { id: "spike", type: "mesh.cone", when: "=glaive", bottomRadius: 0.018, topRadius: 0, height: "=0.3 * length", segments: 6, at: [0, "=shaft + 0.08", 0], region: "blade" },
        // Staff: a cage of bronze ribs around the crystal.
        { id: "cageBase", type: "mesh.torus", when: "=staff", major: 0.07, minor: 0.014, segments: 14, sides: 5, at: [0, "=shaft", 0], region: "trim" },
        {
            id: "cageRibs", type: "mesh.sweep", repeat: 4, when: "=staff", radius: 0.01, sides: 5, region: "trim",
            path: [["=cos(rad(index * 90)) * 0.07", "=shaft", "=sin(rad(index * 90)) * 0.07"], ["=cos(rad(index * 90 + 20)) * 0.1", "=shaft + 0.12", "=sin(rad(index * 90 + 20)) * 0.1"], ["=cos(rad(index * 90 + 40)) * 0.04", "=shaft + 0.28", "=sin(rad(index * 90 + 40)) * 0.04"]],
        },
        { id: "bands", type: "mesh.torus", repeat: 3, when: "=!mono", major: 0.023, minor: 0.006, segments: 10, sides: 4, at: [0, "=index * shaft * 0.3 - below * 0.5", 0], region: "trim" },
    ],
    limits: { maxSize: 3.2, minSize: 0.2, maxTriangles: 8000, floor: false },
};

export default coilRifleDef;
