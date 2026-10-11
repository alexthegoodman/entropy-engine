import type { ObjectDef } from "../mesha_object";

// Body armor for Mesha's human (people.human), sized to its height: a helmet with a visor, a plate
// carrier (front and back plates, side panels, shoulder straps), pauldrons, a belt of pouches,
// knee pads and a power pack on the back with a glowing cell. Model space as the human: facing +Z,
// soles on y = 0. Join it to a human of the same height (games tag its arm and leg parts to move
// with the limbs they sit on).
//
// Lathe arcs start on +X and run through -Z; a sweep of S degrees turned by -90 - S / 2 about Y is
// centered on +Z (the visor), by -10 - (S - 180) / 2 on -Z.

export const combatArmorDef: ObjectDef = {
    id: "people.combat_armor",
    name: "Combat Armor",
    category: "People",
    tags: ["armor", "armour", "soldier", "helmet", "vest", "plate carrier", "military", "body armor", "kit", "gear", "sci-fi", "trooper", "visor"],
    description: "A soldier's armor sized to the human: helmet and visor, plate carrier, pauldrons, belt pouches, knee pads and a glowing power pack.",
    featured: ["height", "visor", "pauldrons", "pack", "plateFinish", "accentFinish"],
    groups: [
        { id: "fit", label: "Fit" },
        { id: "pieces", label: "Pieces" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Wearer height", type: "number", default: 1.75, min: 1.5, max: 2.0, unit: "m", group: "fit", description: "The human's height; everything scales with it." },
        { id: "bulk", label: "Bulk", type: "number", default: 1, min: 0.85, max: 1.25, group: "fit", description: "Wider for a broad build." },
        { id: "helmet", label: "Helmet", type: "bool", default: true, group: "pieces" },
        { id: "visor", label: "Visor", type: "enum", default: "down", options: ["down", "up", "none"], optionLabels: ["Down", "Up", "None"], group: "pieces", visibleIf: "=helmet" },
        { id: "pauldrons", label: "Pauldrons", type: "bool", default: true, group: "pieces" },
        { id: "pouches", label: "Belt pouches", type: "int", default: 4, min: 0, max: 6, group: "pieces" },
        { id: "kneePads", label: "Knee pads", type: "bool", default: true, group: "pieces" },
        { id: "pack", label: "Power pack", type: "bool", default: true, group: "pieces" },
        { id: "plateFinish", label: "Plates", type: "material", default: "composite.slate", materials: ["composite", "paint", "metal.gunmetal"], group: "materials" },
        { id: "softFinish", label: "Webbing", type: "material", default: "fabric.olive", materials: ["fabric", "cloth", "polymer"], group: "materials" },
        { id: "accentFinish", label: "Light", type: "material", default: "glow.cyan", materials: ["glow"], group: "materials" },
        { id: "visorFinish", label: "Visor", type: "material", default: "glass.tinted", materials: ["glass.tinted", "glass.windowBronze", "glass.windowTinted"], group: "materials", visibleIf: "=helmet && visor != 'none'" },
    ],
    derived: {
        k: "=height / 1.7",
        w: "=bulk",
        headY: "=1.63 * height / 1.7",
    },
    regions: {
        plate: { label: "Plates", material: "=plateFinish" },
        soft: { label: "Webbing", material: "=softFinish" },
        visor: { label: "Visor", material: "=visorFinish" },
        light: { label: "Light", material: "=accentFinish" },
        dark: { label: "Fittings", material: "polymer.black" },
    },
    presets: [
        { name: "Expedition trooper", values: {} },
        { name: "Desert trooper", values: { plateFinish: "composite.sand", softFinish: "polymer.tan", accentFinish: "glow.amber" } },
        { name: "Officer, visor up", values: { visor: "up", pouches: 2, pack: false, plateFinish: "composite.black", accentFinish: "glow.white" } },
        { name: "Heavy", values: { bulk: 1.2, pouches: 6, plateFinish: "composite.olive" } },
    ],
    nodes: [
        // --- Helmet: a dome shell over the head, a brim, the visor band, a sensor stalk. ---
        {
            id: "shell", type: "mesh.lathe", when: "=helmet", segments: 24, smoothAngle: 60, region: "plate",
            profile: [["=0.122 * k", "=-0.035 * k"], ["=0.128 * k", "=0.02 * k"], ["=0.118 * k", "=0.07 * k"], ["=0.085 * k", "=0.115 * k"], ["=0.04 * k", "=0.135 * k"], [0, "=0.14 * k"]],
            scale: [1, 1, 1.12], at: [0, "=headY", "=-0.01 * k"],
        },
        { id: "brim", type: "mesh.torus", when: "=helmet", major: "=0.125 * k", minor: "=0.012 * k", segments: 24, sides: 5, scale: [1, 1, 1.12], at: [0, "=headY - 0.035 * k", "=-0.01 * k"], region: "dark" },
        {
            id: "visorBand", type: "mesh.lathe", when: "=helmet && visor != 'none'", sweep: 150, segments: 14, region: "visor",
            profile: [["=0.132 * k", "=-0.06 * k"], ["=0.136 * k", "=0.0 * k"], ["=0.13 * k", "=0.035 * k"]],
            rotate: ["=visor == 'up' ? -55 : 0", -165, 0], scale: [1, 1, 1.1], at: [0, "=headY + (visor == 'up' ? 0.06 : -0.005) * k", "=-0.01 * k"],
        },
        { id: "visorGlow", type: "mesh.box", when: "=helmet && visor == 'down'", size: ["=0.06 * k", "=0.006 * k", "=0.006 * k"], at: ["=0.05 * k", "=headY + 0.012 * k", "=0.135 * k"], region: "light" },
        { id: "stalk", type: "mesh.cylinder", when: "=helmet", radius: "=0.008 * k", height: "=0.08 * k", segments: 6, rotate: [0, 0, 20], at: ["=-0.115 * k", "=headY + 0.06 * k", "=-0.02 * k"], region: "dark" },
        { id: "stalkLight", type: "mesh.sphere", when: "=helmet", radius: "=0.012 * k", segments: 6, rings: 4, at: ["=-0.142 * k", "=headY + 0.135 * k", "=-0.02 * k"], region: "light" },
        // --- Plate carrier. ---
        { id: "frontPlate", type: "mesh.box", size: ["=0.3 * k * w", "=0.33 * k", "=0.045 * k"], radius: "=0.018 * k", divisions: [3, 3, 1], at: [0, "=1.235 * k", "=0.125 * k * w"], region: "plate" },
        { id: "backPlate", type: "mesh.box", size: ["=0.31 * k * w", "=0.36 * k", "=0.045 * k"], radius: "=0.018 * k", at: [0, "=1.24 * k", "=-0.15 * k * w"], region: "plate" },
        { id: "sides", type: "mesh.box", repeat: 2, size: ["=0.04 * k", "=0.2 * k", "=0.25 * k * w"], radius: "=0.01 * k", at: ["=(index == 0 ? 1 : -1) * 0.165 * k * w", "=1.15 * k", "=-0.012 * k"], region: "soft" },
        { id: "straps", type: "mesh.box", repeat: 2, size: ["=0.06 * k", "=0.03 * k", "=0.29 * k * w"], radius: "=0.008 * k", at: ["=(index == 0 ? 1 : -1) * 0.1 * k * w", "=1.415 * k", "=-0.012 * k"], region: "soft" },
        { id: "collar", type: "mesh.torus", major: "=0.085 * k", minor: "=0.025 * k", segments: 18, sides: 6, scale: [1.15, 1, 1], at: [0, "=1.45 * k", "=-0.005 * k"], region: "soft" },
        { id: "chestLight", type: "mesh.box", size: ["=0.12 * k", "=0.01 * k", "=0.006 * k"], at: ["=-0.06 * k", "=1.32 * k", "=0.15 * k * w"], region: "light" },
        { id: "chestPouches", type: "mesh.box", repeat: 3, size: ["=0.075 * k", "=0.1 * k", "=0.04 * k"], radius: "=0.008 * k", at: ["=(index - 1) * 0.088 * k * w", "=1.13 * k", "=0.162 * k * w"], region: "soft" },
        // --- Pauldrons over the shoulders. ---
        {
            id: "pauldron", type: "mesh.lathe", repeat: 2, when: "=pauldrons", segments: 14, smoothAngle: 70, region: "plate",
            profile: [["=0.075 * k", "=-0.03 * k"], ["=0.075 * k", "=0.01 * k"], ["=0.05 * k", "=0.05 * k"], [0, "=0.065 * k"]],
            scale: [1, 1, 1.25], rotate: [0, 0, "=index == 0 ? -28 : 28"], at: ["=(index == 0 ? 1 : -1) * 0.215 * k * w", "=1.405 * k", "=-0.01 * k"],
        },
        // --- Belt and pouches. ---
        { id: "belt", type: "mesh.torus", major: "=0.165 * k * w", minor: "=0.022 * k", segments: 24, sides: 6, scale: [1.08, 1, 0.92], at: [0, "=0.975 * k", "=0.005 * k"], region: "soft" },
        {
            id: "beltPouches", type: "mesh.box", repeat: "=pouches", when: "=pouches > 0", size: ["=0.075 * k", "=0.085 * k", "=0.05 * k"], radius: "=0.01 * k",
            rotate: [0, "=180 + (index - (pouches - 1) / 2) * 34", 0],
            at: ["=sin(rad(180 + (index - (pouches - 1) / 2) * 34)) * 0.18 * k * w", "=0.955 * k", "=cos(rad(180 + (index - (pouches - 1) / 2) * 34)) * 0.17 * k * w"], region: "soft",
        },
        // --- Knee pads. ---
        { id: "knees", type: "mesh.sphere", repeat: 2, when: "=kneePads", radius: "=0.058 * k", segments: 12, rings: 8, scale: [1, 1.2, 0.6], at: ["=(index == 0 ? 1 : -1) * 0.095 * k", "=0.5 * k", "=0.075 * k"], region: "plate" },
        // --- Power pack. ---
        { id: "packBody", type: "mesh.box", when: "=pack", size: ["=0.24 * k", "=0.3 * k", "=0.1 * k"], radius: "=0.025 * k", at: [0, "=1.22 * k", "=-0.22 * k * w"], region: "plate" },
        { id: "packCell", type: "mesh.cylinder", when: "=pack", radius: "=0.03 * k", height: "=0.22 * k", segments: 10, at: [0, "=1.11 * k", "=-0.275 * k * w"], region: "light" },
        { id: "packVents", type: "mesh.box", repeat: 3, when: "=pack", size: ["=0.18 * k", "=0.012 * k", "=0.01 * k"], at: [0, "=(1.28 + index * 0.03) * k", "=-0.272 * k * w"], region: "dark" },
    ],
    limits: { maxSize: 2.2, minSize: 0.3, maxTriangles: 20000, floor: false },
};

export default combatArmorDef;
