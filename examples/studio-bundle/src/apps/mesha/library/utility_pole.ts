import type { ObjectDef } from "../mesha_object";

// A timber (or concrete) utility pole carrying its wires toward the next pole, `span` metres along
// +X, sagging between them. Crossarms run along Z with insulators on top; a streetlight arm reaches
// out along +Z, toward the road. Lean tips the pole about X (along the arms), and the wires leave
// from where the leaning insulators really are. One wire can be snapped, falling to the ground and
// trailing along it; the lowest arm can hang broken. Wire ends sit at the next (upright) pole's
// insulators, so a row of poles `span` apart turned along a road reads as one line.

/** Insulator j (0..3) of arm a: its local position before the lean. */
const IZ = (j: string) => `((${j}) - 1.5) * armWidth * 0.3`;
const IY = (a: string) => `(height - 0.45 - (${a}) * 0.9 + 0.2)`;
/** That point after leaning `lean` degrees about X. */
const leanY = (y: string, z: string) => `((${y}) * cos(rad(lean)) - (${z}) * sin(rad(lean)))`;
const leanZ = (y: string, z: string) => `((${y}) * sin(rad(lean)) + (${z}) * cos(rad(lean)))`;
// Wire w of a repeat: arm floor(w / 4), insulator w % 4.
const WA = "floor(index / 4)", WJ = "(index % 4)";
const wirePoints = (): [string, string, string][] => Array.from({ length: 13 }, (_, k) => {
    const t = k / 12;
    const y0 = leanY(IY(WA), IZ(WJ)), z0 = leanZ(IY(WA), IZ(WJ));
    return [
        `=span * ${t.toFixed(4)}`,
        `=lerp(${y0}, ${IY(WA)}, ${t.toFixed(4)}) - 4 * sag * (1 + (rand(index, 3) - 0.5) * 0.3) * ${(t * (1 - t)).toFixed(4)}`,
        `=lerp(${z0}, ${IZ(WJ)}, ${t.toFixed(4)})`,
    ] as [string, string, string];
});
/** The snapped wire: from the top arm's outer insulator, down in a curve, then along the ground. */
const snapped = (): (string | number)[][] => {
    const y0 = leanY(IY("0"), IZ("3")), z0 = leanZ(IY("0"), IZ("3"));
    return [
        [0, `=${y0}`, `=${z0}`], ["=snapReach * 0.15", `=${y0} * 0.75`, `=${z0} + 0.1`], ["=snapReach * 0.3", `=${y0} * 0.35`, `=${z0} + 0.25`],
        ["=snapReach * 0.42", 0.06, `=${z0} + 0.45`], ["=snapReach * 0.7", 0.04, `=${z0} + 1.1`], ["=snapReach", 0.04, `=${z0} + 0.6`],
    ];
};

export const utilityPoleDef: ObjectDef = {
    id: "street.utility_pole",
    name: "Utility Pole",
    category: "Street",
    tags: ["utility pole", "telephone pole", "power pole", "electricity", "power line", "wires", "cables", "telegraph", "pylon", "street", "leaning", "post-apocalyptic", "wasteland", "abandoned", "rural"],
    description: "A leaning timber utility pole with crossarms, insulators and wires sagging to the next pole, a transformer can, a streetlight arm, a broken arm and a snapped live wire on the ground.",
    featured: ["height", "lean", "crossarms", "span", "sag", "snapped", "lamp", "poleFinish"],
    groups: [
        { id: "pole", label: "Pole" },
        { id: "wires", label: "Wires" },
        { id: "fittings", label: "Fittings" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 9, min: 6, max: 13, unit: "m", group: "pole" },
        { id: "lean", label: "Lean", type: "number", default: 5, min: -14, max: 14, unit: "deg", group: "pole", description: "Tips the pole along its arms (about X)." },
        { id: "crossarms", label: "Crossarms", type: "int", default: 2, min: 1, max: 3, group: "pole" },
        { id: "armWidth", label: "Arm width", type: "number", default: 2.2, min: 1.4, max: 3, unit: "m", group: "pole" },
        { id: "brokenArm", label: "Broken arm", type: "bool", default: false, group: "pole", visibleIf: "=crossarms > 1", description: "The lowest arm hangs from one bolt; its wires are gone." },
        { id: "wires", label: "Wires", type: "bool", default: true, group: "wires" },
        { id: "span", label: "Span to next pole", type: "number", default: 22, min: 8, max: 40, unit: "m", group: "wires", visibleIf: "=wires" },
        { id: "sag", label: "Sag", type: "number", default: 1.1, min: 0.2, max: 3, unit: "m", group: "wires", visibleIf: "=wires" },
        { id: "snapped", label: "Snapped wire", type: "bool", default: true, group: "wires" },
        { id: "snapReach", label: "Snapped wire reach", type: "number", default: 5, min: 2.5, max: 9, unit: "m", group: "wires", visibleIf: "=snapped" },
        { id: "transformer", label: "Transformer", type: "bool", default: true, group: "fittings" },
        { id: "lamp", label: "Streetlight arm", type: "bool", default: true, group: "fittings" },
        { id: "lampLit", label: "Lamp still lit", type: "bool", default: false, group: "fittings", visibleIf: "=lamp" },
        { id: "steps", label: "Climbing steps", type: "bool", default: true, group: "fittings" },
        { id: "poleFinish", label: "Pole", type: "material", default: "wood.weathered", materials: ["wood.weathered", "wood.charred", "wood.sleeper", "masonry.concrete", "masonry.darkConcrete", "metal.rust"], group: "materials" },
        { id: "armFinish", label: "Crossarms", type: "material", default: "wood.weathered", materials: ["wood.weathered", "wood.charred", "wood.sleeper", "metal.rust", "metal.black"], group: "materials" },
        { id: "insulatorFinish", label: "Insulators", type: "material", default: "glass.green", materials: ["glass.green", "glass.clear", "glass.amber", "ceramic.white", "ceramic.speckled"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 17, group: "materials", variation: 0 },
    ],
    derived: {
        lampY: "=height * 0.68",
        sparkY: "=height - 0.45",
    },
    rules: [
        { check: "=height - 0.45 - (crossarms - 1) * 0.9 > height * 0.68 + 0.6", message: "The crossarms come down onto the streetlight arm." },
    ],
    regions: {
        pole: { label: "Pole", material: "=poleFinish" },
        arms: { label: "Crossarms", material: "=armFinish" },
        insulators: { label: "Insulators", material: "=insulatorFinish" },
        steel: { label: "Brackets and steps", material: "metal.rust" },
        wire: { label: "Wires", material: "metal.black" },
        can: { label: "Transformer", material: "metal.rustDark" },
        lamp: { label: "Lamp", material: "=lampLit ? 'glow.amber' : 'glass.frosted'" },
    },
    presets: [
        { name: "Leaning line pole", values: {} },
        { name: "Upright country pole", values: { lean: 0, crossarms: 1, snapped: false, transformer: false, lamp: false, sag: 0.7, seed: 4 } },
        { name: "Downtown junction", values: { height: 11, crossarms: 3, armWidth: 2.6, lean: -3, lampLit: true, snapped: false, sag: 1.5, seed: 9 } },
        { name: "Storm-wrecked", values: { lean: 13, crossarms: 2, brokenArm: true, snapped: true, snapReach: 7, sag: 2.6, lamp: false, poleFinish: "wood.charred", armFinish: "wood.charred", seed: 21 } },
        { name: "Concrete pole", values: { height: 10, lean: 2, poleFinish: "masonry.darkConcrete", armFinish: "metal.rust", insulatorFinish: "ceramic.white", steps: false, seed: 6 } },
    ],
    nodes: [
        // The leaning parts are joined, then tipped together; wires are computed already leaning.
        { id: "shaft", type: "mesh.cone", output: false, bottomRadius: 0.16, topRadius: 0.11, height: "=height", segments: 14, region: "pole" },
        { id: "cap", type: "mesh.cone", output: false, bottomRadius: 0.12, topRadius: 0.02, height: 0.14, segments: 14, at: [0, "=height", 0], region: "steel" },
        { id: "arms", type: "mesh.box", output: false, repeat: "=crossarms", size: [0.11, 0.11, "=armWidth"],
            rotate: ["=brokenArm && index == crossarms - 1 && crossarms > 1 ? 32 : 0", 0, 0],
            at: [0.13, "=height - 0.45 - index * 0.9 - (brokenArm && index == crossarms - 1 && crossarms > 1 ? armWidth * 0.2 : 0)", "=brokenArm && index == crossarms - 1 && crossarms > 1 ? armWidth * 0.06 : 0"], region: "arms" },
        { id: "braces", type: "mesh.box", output: false, repeat: "=crossarms * 2", keep: "=!(brokenArm && floor(index / 2) == crossarms - 1 && crossarms > 1)", size: [0.04, 0.04, 0.7],
            rotate: ["=(index % 2 == 0 ? 1 : -1) * 40", 0, 0], at: [0.13, "=height - 0.45 - floor(index / 2) * 0.9 - 0.27", "=(index % 2 == 0 ? 1 : -1) * 0.22"], region: "steel" },
        { id: "insulators", type: "mesh.cone", output: false, repeat: "=crossarms * 4", keep: "=!(brokenArm && floor(index / 4) == crossarms - 1 && crossarms > 1)",
            bottomRadius: 0.05, topRadius: 0.035, height: 0.16, segments: 8, bevel: 0.01,
            at: [0.13, "=height - 0.45 - floor(index / 4) * 0.9 + 0.055", `=${IZ("index % 4")}`], region: "insulators" },
        { id: "can", type: "mesh.cylinder", output: false, when: "=transformer", radius: 0.26, height: 0.75, segments: 16, bevel: 0.03, at: [-0.42, "=height * 0.74", 0], region: "can" },
        { id: "canLid", type: "mesh.cylinder", output: false, when: "=transformer", radius: 0.28, height: 0.06, segments: 16, at: [-0.42, "=height * 0.74 + 0.75", 0], region: "steel" },
        { id: "canBracket", type: "mesh.box", output: false, when: "=transformer", size: [0.3, 0.08, 0.12], at: [-0.2, "=height * 0.74 + 0.4", 0], region: "steel" },
        { id: "lampArmPath", type: "path.points", output: false, smooth: 6, points: [[0, "=lampY", 0.12], [0, "=lampY + 0.35", 0.7], [0, "=lampY + 0.5", 1.6], [0, "=lampY + 0.42", 2.2]] },
        { id: "lampArm", type: "mesh.sweep", output: false, when: "=lamp", path: "@lampArmPath", radius: 0.035, sides: 8, region: "steel" },
        { id: "lampHead", type: "mesh.box", output: false, when: "=lamp", size: [0.3, 0.14, 0.55], radius: 0.05, rotate: [-6, 0, 0], at: [0, "=lampY + 0.36", 2.32], region: "steel" },
        { id: "lampLens", type: "mesh.box", output: false, when: "=lamp", size: [0.22, 0.03, 0.42], rotate: [-6, 0, 0], at: [0, "=lampY + 0.28", 2.33], region: "lamp" },
        { id: "steps", type: "mesh.cylinder", output: false, when: "=steps", repeat: "=floor((height - 3) / 0.45)", radius: 0.018, height: 0.32, segments: 6,
            rotate: [0, 0, 90], at: ["=(index % 2 == 0 ? 1 : -1) * 0.13 + (index % 2 == 0 ? 0.16 : 0)", "=2.4 + index * 0.45", "=index % 2 == 0 ? 0 : 0"], region: "steel" },
        { id: "pole", type: "geo.join", meshes: ["@shaft", "@cap", "@arms", "@braces", "@insulators", "@can", "@canLid", "@canBracket", "@lampArm", "@lampHead", "@lampLens", "@steps"], rotate: ["=lean", 0, 0] },
        // Wires, already leaning at the pole end.
        { id: "lines", type: "mesh.sweep", when: "=wires", repeat: "=crossarms * 4", keep: "=!(brokenArm && floor(index / 4) == crossarms - 1 && crossarms > 1) && !(snapped && index == 3)",
            path: wirePoints(), radius: 0.013, sides: 5, caps: false, region: "wire" },
        { id: "snappedWire", type: "mesh.sweep", when: "=snapped", path: { if: "=snapped", then: snapped(), else: [[0, 0, 0], [1, 0, 0]] }, radius: 0.014, sides: 5, caps: false, region: "wire" },
    ],
    limits: { maxSize: 45, minSize: 5, maxTriangles: 20000 },
};

export default utilityPoleDef;
