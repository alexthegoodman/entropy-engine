import type { ObjectDef, NodeDef } from "../mesha_object";

/**
 * A conifer: a tapering trunk hung with tiers of needled boughs (each a pinnate frond drooping from
 * the trunk), a leader spike on top and, if asked for, hanging cones.
 */

// The crown outline by tier position v (0 bottom .. 1 top): bough length as a share of the base radius.
const profile = "select(shapeIdx, 1 - 0.94 * v, pow(1 - v, 0.85) * 0.96 + 0.04, (0.55 + 0.45 * sin(PI * (v * 0.9 + 0.05))) * (1 - 0.5 * v), 0.34 * (0.6 + 0.4 * sin(PI * (0.1 + 0.85 * v))) + 0.02)";

const conifer: ObjectDef = {
    id: "nature.conifer",
    name: "Conifer",
    category: "Nature",
    tags: ["conifer", "pine", "spruce", "fir", "cypress", "evergreen", "christmas tree", "tree", "needles", "foliage", "plant", "nature", "landscape", "forest"],
    description: "Spruce, fir, pine or cypress: tiers of needled boughs on a tapering trunk, with optional cones.",
    featured: ["height", "baseWidth", "shape", "tiers", "needleFinish", "cones", "seed"],
    groups: [
        { id: "size", label: "Size" },
        { id: "crown", label: "Crown & boughs" },
        { id: "needles", label: "Needles" },
        { id: "extras", label: "Cones" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 12, min: 3, max: 45, unit: "m", group: "size" },
        { id: "baseWidth", label: "Crown radius", type: "number", default: 3.4, min: "=height * 0.06", max: "=height * 0.55", unit: "m", group: "size", description: "Reach of the lowest boughs." },
        { id: "crownStart", label: "Clear trunk", type: "number", default: 0.1, min: 0.02, max: 0.55, group: "size", description: "Share of the height that is bare trunk." },
        { id: "trunkRadius", label: "Trunk radius", type: "number", default: 0.26, min: "=height * 0.01 + 0.02", max: "=height * 0.06 + 0.05", unit: "m", group: "size" },
        { id: "shape", label: "Shape", type: "enum", default: "spruce", options: ["spruce", "fir", "pine", "cypress"], optionLabels: ["Spruce (cone)", "Fir (dense)", "Pine (layered)", "Cypress (column)"], group: "crown" },
        { id: "tiers", label: "Tiers", type: "int", default: 12, min: 3, max: 18, group: "crown" },
        { id: "boughs", label: "Boughs per tier", type: "int", default: 9, min: 4, max: 12, group: "crown" },
        { id: "boughRise", label: "Bough angle", type: "number", default: 8, min: -25, max: 80, unit: "°", group: "crown", description: "Positive lifts the boughs, negative lowers them." },
        { id: "boughDroop", label: "Bough droop", type: "number", default: 45, min: 5, max: "=min(100, 40 + boughRise * 1.2 + 250 * crownStart * height / max(1, baseWidth))", unit: "°", group: "crown", description: "How far each bough arches over at its tip." },
        { id: "irregularity", label: "Irregularity", type: "number", default: 0.3, min: 0, max: 1, group: "crown" },
        { id: "needleDensity", label: "Needle density", type: "int", default: 15, min: 6, max: "=min(22, max(6, floor((60000 / (tiers * boughs) - 100) / 16)))", group: "needles", description: "Needle pairs along each bough." },
        { id: "needleLength", label: "Needle length", type: "number", default: 0.4, min: 0.1, max: 0.55, group: "needles", description: "As a share of the bough's length." },
        { id: "needleWidth", label: "Needle width", type: "number", default: 0.24, min: 0.05, max: 0.45, group: "needles" },
        { id: "needleAngle", label: "Needle sweep", type: "number", default: 64, min: 30, max: 85, unit: "°", group: "needles" },
        { id: "needleLift", label: "Needle lift", type: "number", default: 22, min: 0, max: 45, unit: "°", group: "needles", description: "How far needles fan up out of the bough's plane." },
        { id: "needleFold", label: "Needle fold", type: "number", default: 35, min: 0, max: 70, unit: "°", group: "needles" },
        { id: "cones", label: "Cones", type: "int", default: 0, min: 0, max: 40, group: "extras" },
        { id: "coneSize", label: "Cone length", type: "number", default: 0.2, min: 0.08, max: 0.6, unit: "m", group: "extras", visibleIf: "=cones > 0" },
        { id: "needleFinish", label: "Needles", type: "material", default: "leaf.pine", materials: ["leaf"], group: "materials" },
        { id: "barkFinish", label: "Bark", type: "material", default: "bark.pine", materials: ["bark"], group: "materials" },
        { id: "coneFinish", label: "Cones", type: "material", default: "bark.pine", materials: ["bark"], group: "materials", visibleIf: "=cones > 0" },
        { id: "seed", label: "Seed", type: "seed", default: 5, group: "materials", variation: 0 },
    ],
    derived: {
        shapeIdx: "=(shape == 'spruce' ? 0 : (shape == 'fir' ? 1 : (shape == 'pine' ? 2 : 3)))",
        crownBase: "=height * crownStart",
        crownH: "=height * 0.94 - crownBase",
        leaderH: "=height * 0.07 + 0.3",
    },
    regions: {
        bark: { label: "Trunk", material: "=barkFinish" },
        needles: { label: "Needles", material: "=needleFinish" },
        cone: { label: "Cones", material: "=coneFinish" },
    },
    presets: [
        { name: "Norway spruce", values: { height: 14, baseWidth: 3.6, shape: "spruce", tiers: 13, boughDroop: 60, needleFinish: "leaf.forest" } },
        { name: "Balsam fir", values: { height: 10, baseWidth: 2.6, shape: "fir", tiers: 14, boughs: 9, boughDroop: 40, needleDensity: 15, needleLength: 0.36, needleFinish: "leaf.deep", barkFinish: "bark.grey" } },
        { name: "Scots pine", values: { height: 16, baseWidth: 4.4, shape: "pine", crownStart: 0.5, tiers: 7, boughs: 7, boughRise: 12, boughDroop: 28, needleLength: 0.5, needleWidth: 0.34, needleDensity: 14, needleFinish: "leaf.olive", barkFinish: "bark.red", trunkRadius: 0.32, cones: 8, coneFinish: "bark.pine", irregularity: 0.6 } },
        { name: "Blue spruce", values: { height: 9, baseWidth: 2.8, shape: "spruce", tiers: 11, boughRise: 2, boughDroop: 28, needleFinish: "leaf.blue", barkFinish: "bark.dark" } },
        { name: "Italian cypress", values: { height: 12, baseWidth: 4.5, shape: "cypress", crownStart: 0.04, tiers: 18, boughs: 8, boughRise: 70, boughDroop: 5, needleLength: 0.45, needleWidth: 0.45, needleDensity: 10, needleFinish: "leaf.forest", barkFinish: "bark.grey" } },
        { name: "Forest fir sapling", values: { height: 4, baseWidth: 1.3, shape: "fir", crownStart: 0.06, tiers: 8, needleFinish: "leaf.fresh", trunkRadius: 0.07 } },
    ],
    nodes: [
        { id: "trunkRaw", type: "mesh.cone", output: false, bottomRadius: "=trunkRadius", topRadius: "=trunkRadius * 0.12", height: "=height * 0.94", segments: 12 },
        { id: "trunk", type: "deform.noise", mesh: "@trunkRaw", amount: "=trunkRadius * 0.14", frequency: "=1.2 / max(0.3, trunkRadius * 3)", octaves: 3, seed: "=seed", region: "bark" },
        { id: "leader", type: "mesh.cone", bottomRadius: "=trunkRadius * 0.5 + baseWidth * 0.03", topRadius: 0.005, height: "=leaderH", segments: 6, at: [0, "=height * 0.94 - leaderH * 0.35", 0], region: "needles" },
        {
            id: "boughs", type: "mesh.frond", repeat: "=tiers * boughs",
            length: `=max(0.25, baseWidth * ${profile.replace(/\bv\b/g, "(floor(index / boughs) / (tiers - 1))")} * (1 + (rand(index, 1) - 0.5) * irregularity * 0.7))`,
            pairs: "=needleDensity", leafletLength: "=needleLength", leafletWidth: "=needleWidth", angle: "=needleAngle", lift: "=needleLift", droop: "=needleFold * 0.7",
            curl: "=boughDroop * (1.15 - 0.4 * (floor(index / boughs) / (tiers - 1)))", peak: 0.45, gap: 0.12, rachis: "=max(0.004, baseWidth * 0.012)", fold: "=needleFold",
            at: [0, "=crownBase + crownH * (floor(index / boughs) / (tiers - 1)) * 0.98 + (rand(index, 3) - 0.5) * irregularity * crownH * 0.04", 0],
            rotate: ["=-90 + boughRise + (rand(index, 2) - 0.5) * irregularity * 26", "=(index % boughs) * 360 / boughs + floor(index / boughs) * 137.5 + (rand(index, 4) - 0.5) * irregularity * 50", 0],
            region: "needles",
        },
        { id: "coneBody", type: "mesh.cone", output: false, when: "=cones > 0", bottomRadius: "=coneSize * 0.24", topRadius: "=coneSize * 0.09", height: "=coneSize", segments: 8 },
        { id: "coneHang", type: "geo.transform", output: false, when: "=cones > 0", mesh: "@coneBody", rotate: [180, 0, 0], at: [0, "=coneSize", 0] },
        {
            id: "coneScatter", type: "instance.scatter", when: "=cones > 0", mesh: "@coneHang", centers: [[0, "=crownBase + crownH * 0.12", 0]], count: "=cones", volume: "cone",
            size: ["=baseWidth * 0.75", "=crownH * 0.75", "=baseWidth * 0.75"], hollow: 0.6, orient: "up", spread: 0, droop: 0, scaleMin: 0.8, scaleMax: 1.25, roll: 180, seed: "=seed * 3 + 2", region: "cone",
        },
    ] as NodeDef[],
    limits: { maxSize: 60, minSize: 0.5, maxTriangles: 90000, floorTolerance: 0.05 },
};

export default conifer;
