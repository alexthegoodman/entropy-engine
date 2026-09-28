import type { ObjectDef } from "../mesha_object";

/**
 * A conifer: one leader to the top with whorls of limbs, dressed in flat needle sprays (fir,
 * spruce), bottlebrush needle tufts (pine), or stylized stacked tiers.
 */
const conifer: ObjectDef = {
    id: "nature.conifer", name: "Conifer", category: "Nature",
    tags: ["conifer", "pine", "spruce", "fir", "cypress", "christmas tree", "evergreen", "tree", "needles", "foliage", "forest", "nature", "landscape"],
    description: "Spruce, fir, pine or cypress: a single leader with whorled limbs and needle sprays, pine tufts or stylized tiers.",
    featured: ["height", "crownWidth", "foliage", "droop", "crownBase", "needleFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "shape", label: "Shape" },
        { id: "foliage", label: "Needles" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 9, min: 1, max: 30, unit: "m", group: "size" },
        { id: "trunkRadius", label: "Trunk radius", type: "number", default: 0.2, min: "=height * 0.008", max: "=height * 0.045", unit: "m", decimals: 2, group: "size" },
        { id: "crownWidth", label: "Crown width", type: "number", default: 0.44, min: 0.12, max: 1.2, group: "shape", description: "Longest limb relative to the crown's height." },
        { id: "crownShape", label: "Crown shape", type: "enum", default: "conical", options: ["conical", "columnar", "round"], optionLabels: ["Conical", "Columnar", "Rounded (pine)"], group: "shape" },
        { id: "crownBase", label: "Bare trunk", type: "number", default: 0.08, min: 0.02, max: 0.75, group: "shape" },
        { id: "whorls", label: "Limbs", type: "int", default: 34, min: 10, max: 64, group: "shape" },
        { id: "twigs", label: "Branchlets", type: "int", default: 4, min: 2, max: 7, group: "shape" },
        { id: "branchAngle", label: "Limb angle", type: "number", default: 80, min: 35, max: 110, unit: "°", group: "shape" },
        { id: "droop", label: "Droop", type: "number", default: 0.45, min: -0.5, max: 1.6, group: "shape", description: "How far limbs sag toward their tips." },
        { id: "lean", label: "Lean", type: "number", default: 1, min: 0, max: 25, unit: "°", group: "shape" },
        { id: "gnarl", label: "Gnarl", type: "number", default: 0.15, min: 0, max: 0.9, group: "shape" },
        { id: "foliage", label: "Foliage", type: "enum", default: "sprays", options: ["sprays", "tufts", "tiers"], optionLabels: ["Needle sprays", "Pine tufts", "Stylized tiers"], group: "foliage" },
        { id: "sprayLength", label: "Spray length", type: "number", default: 0.75, min: 0.15, max: 1.4, unit: "m", group: "foliage", visibleIf: "=foliage == 'sprays'" },
        { id: "needleLength", label: "Needle length", type: "number", default: 0.26, min: 0.06, max: 0.45, unit: "m", group: "foliage", visibleIf: "=foliage == 'tufts'" },
        { id: "density", label: "Density", type: "int", default: 9, min: 3, max: 20, group: "foliage", visibleIf: "=foliage != 'tiers'" },
        { id: "tiers", label: "Tiers", type: "int", default: 6, min: 3, max: 12, group: "foliage", visibleIf: "=foliage == 'tiers'" },
        { id: "tierPoints", label: "Tier points", type: "int", default: 9, min: 5, max: 16, group: "foliage", visibleIf: "=foliage == 'tiers'" },
        { id: "variety", label: "Color variety", type: "number", default: 0.45, min: 0, max: 1, group: "foliage" },
        { id: "barkFinish", label: "Bark", type: "material", default: "bark.pine", materials: ["bark"], group: "materials" },
        { id: "needleFinish", label: "Needles", type: "material", default: "leaf.spruce", materials: ["leaf.spruce", "leaf.blue", "leaf.dark", "leaf.green", "leaf.olive", "leaf.gold"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 9, group: "materials", variation: 0 },
    ],
    derived: {
        crownH: "=height * (1 - crownBase)",
        tierBottom: "=height * crownBase * 0.6",
    },
    rules: [
        { check: "=!(crownShape == 'round' && crownBase < 0.3)", message: "A rounded pine crown sits on a tall bare trunk (raise the bare trunk)." },
    ],
    regions: {
        bark: { label: "Bark", material: "=barkFinish" },
        leaves: { label: "Needles", material: "=needleFinish" },
    },
    presets: [
        { name: "Norway spruce", values: {} },
        { name: "Blue spruce", values: { height: 7, crownWidth: 0.5, branchAngle: 88, droop: 0.2, sprayLength: 0.62, density: 11, needleFinish: "leaf.blue", barkFinish: "bark.grey", seed: 4 } },
        { name: "Scots pine", values: { height: 13, trunkRadius: 0.24, crownShape: "round", crownBase: 0.6, crownWidth: 1, whorls: 10, twigs: 5, branchAngle: 60, droop: 0, lean: 6, gnarl: 0.7, foliage: "tufts", needleLength: 0.4, density: 10, needleFinish: "leaf.dark", barkFinish: "bark.pine", seed: 17 } },
        { name: "Italian cypress", values: { height: 12, trunkRadius: 0.16, crownShape: "columnar", crownBase: 0.04, crownWidth: 0.2, whorls: 48, twigs: 3, branchAngle: 38, droop: -0.3, sprayLength: 0.6, density: 12, needleFinish: "leaf.dark", barkFinish: "bark.oak", seed: 23 } },
        { name: "Stylized pine", values: { height: 6, trunkRadius: 0.16, foliage: "tiers", tiers: 5, tierPoints: 8, crownWidth: 0.4, crownBase: 0.12, needleFinish: "leaf.dark", variety: 0.6, seed: 2 } },
        { name: "Golden fir", values: { height: 5, trunkRadius: 0.12, crownWidth: 0.38, branchAngle: 76, droop: 0.3, sprayLength: 0.5, density: 12, needleFinish: "leaf.gold", barkFinish: "bark.grey", seed: 31 } },
    ],
    nodes: [
        // A flat needle spray: a sawtooth outline reads as a fir or spruce sprig.
        { id: "spray", type: "mesh.leaf", output: false, shape: "spray", length: "=sprayLength", width: "=sprayLength * 0.5", fold: 14, curl: 30, lobes: 8, segments: 3, region: "leaves" },
        // A pine tuft: needles fanned around its twig, bottlebrush fashion (built around +Y, then turned to +Z).
        { id: "needle", type: "mesh.leaf", output: false, shape: "blade", length: "=needleLength", width: "=needleLength * 0.07", fold: 0, curl: 14, segments: 2, rotate: [-38, 0, 0] },
        { id: "tuftRing", type: "instance.radial", output: false, mesh: "@needle", count: 12 },
        { id: "tuft", type: "geo.transform", output: false, mesh: "@tuftRing", rotate: [90, 0, 0], region: "leaves" },
        {
            id: "tree", type: "plant.tree", barkRegion: "bark",
            height: "=height", trunkRadius: "=trunkRadius", levels: "=foliage == 'tiers' ? 0 : crownShape == 'round' ? 3 : 2", branches: "=whorls", twigs: "=twigs",
            crownBase: "=crownBase", leader: 1, angle: "=branchAngle", reach: "=crownWidth", subReach: 0.42, crownShape: "=crownShape",
            radiusRatio: 0.3, gnarl: "=gnarl", droop: "=droop", lean: "=lean", flare: 0.35, bark: 0.8, sides: 12, segments: 5, seed: "=seed",
            leaf: { if: "=foliage == 'tufts'", then: "@tuft", else: "@spray" },
            leaves: "=foliage == 'tiers' ? 0 : density", leafStart: 0.1, leafAngle: "=foliage == 'tufts' ? 20 : 55", leafDroop: "=foliage == 'tufts' ? 0 : 0.1 + droop * 0.15",
            leafAlign: "=foliage == 'tufts' ? 'twig' : 'flat'",
            leafScaleVariation: 0.2, tintVariation: "=variety", leafBudget: 130000,
        },
        // Stylized tiers: jagged cones stacked up the trunk, each a little narrower and turned.
        { id: "tierOutline", type: "curve.star", output: false, outer: 1, inner: 0.72, points: "=tierPoints" },
        { id: "tierTop", type: "curve.circle", output: false, radius: 0.08, segments: "=tierPoints" },
        { id: "tierCone", type: "mesh.loft", output: false, bottom: "@tierOutline", top: "@tierTop", height: 1 },
        {
            id: "tierStack", type: "geo.transform", output: false, when: "=foliage == 'tiers'", mesh: "@tierCone", repeat: "=tiers",
            scale: ["=crownH * crownWidth * 1.35 * lerp(1, 0.28, t)", "=crownH / tiers * 1.75", "=crownH * crownWidth * 1.35 * lerp(1, 0.28, t)"],
            rotate: [0, "=index * 23", 0],
            at: [0, "=tierBottom + t * (height - tierBottom - crownH / tiers * 1.6)", 0],
        },
        { id: "tiersShaded", type: "plant.shade", when: "=foliage == 'tiers'", mesh: "@tierStack", occlusion: 0.05, gradient: 0.35, tintVariation: "=variety", seed: "=seed", region: "leaves" },
    ],
    limits: { maxSize: 45, minSize: 0.8, maxTriangles: 220000 },
};

export default conifer;
