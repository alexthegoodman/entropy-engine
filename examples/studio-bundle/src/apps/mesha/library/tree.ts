import type { ObjectDef, NodeDef } from "../mesha_object";

/**
 * A broadleaf tree: a leaning, flared trunk, a spiral of arching branches and twigs grown to a crown
 * outline, and clumps of leaves (plus optional blossom or fruit) on every tip.
 */

// The leaf outlines. Each row is one shape: [width/length, widest at, fullness, teeth, lobes].
const SHAPES = ["ovate", "elliptic", "narrow", "round", "serrated", "maple"];
export const leafShapeParam = (group: string, def = "ovate") => ({
    id: "leafShape", label: "Leaf shape", type: "enum" as const, default: def, options: SHAPES, group,
    optionLabels: ["Ovate", "Elliptic", "Narrow (willow)", "Round (aspen)", "Serrated (birch)", "Maple (palmate)"],
});
export const SHAPE_DERIVED: Record<string, string> = {
    shapeIdx: "=(leafShape == 'ovate' ? 0 : (leafShape == 'elliptic' ? 1 : (leafShape == 'narrow' ? 2 : (leafShape == 'round' ? 3 : (leafShape == 'serrated' ? 4 : 5)))))",
    leafRatio: "=select(shapeIdx, 0.62, 0.42, 0.2, 0.86, 0.56, 1.05)",
    leafWidest: "=select(shapeIdx, 0.36, 0.45, 0.45, 0.45, 0.34, 0.5)",
    leafFull: "=select(shapeIdx, 0.9, 1, 1.25, 0.55, 0.95, 1)",
    leafTeeth: "=select(shapeIdx, 0, 0, 0, 0, 8, 0)",
    leafLobes: "=select(shapeIdx, 0, 0, 0, 0, 0, 5)",
    leafCost: "=select(shapeIdx, 1, 1, 1, 1, 2.5, 2.5)",
};

const treeCap = "=max(3, floor(1300 / (branchCount * (1 + twigs) + 1) / leafCost))";
const fruitCap = "=max(1, floor(420 / (branchCount * (1 + twigs) + 1)))";

const trunkPoints = [0, 0.25, 0.5, 0.75, 1].map(f => [
    `=leaderH * ${f} * tan(rad(lean)) + sway * height * 0.05 * sin(${f} * PI * 1.3)`,
    `=leaderH * ${f}`,
    `=sway * height * 0.03 * sin(${f} * PI * 0.9 + 1)`,
]);

const branchInputs = {
    trunk: "@trunkPath", count: "=branchCount", crownBase: "=crownBase", crownHeight: "=crownH", crownRadius: "=crownR", envelope: "=crownShape",
    angle: "=branchAngle", droop: "=weeping", arch: "=branchArch", radius: "=trunkRadius * branchThickness", taper: 0.25,
    twigs: "=twigs", twigLength: 0.5, twigSpread: 50, jitter: "=irregularity", minTipY: "=clumpSize * 0.8", seed: "=seed * 5 + 3",
};

const tree: ObjectDef = {
    id: "nature.tree",
    name: "Tree",
    category: "Nature",
    tags: ["tree", "oak", "birch", "maple", "willow", "cherry", "apple", "olive", "poplar", "foliage", "plant", "leaf", "deciduous", "forest", "nature", "landscape", "blossom", "autumn"],
    description: "Broadleaf tree with a shaped crown of branches, leaf clumps, blossom or fruit.",
    featured: ["height", "crownWidth", "crownShape", "leafShape", "leafFinish", "barkFinish", "leavesPerClump", "seed"],
    groups: [
        { id: "size", label: "Size" },
        { id: "trunk", label: "Trunk" },
        { id: "crown", label: "Crown & branches" },
        { id: "leaves", label: "Leaves" },
        { id: "extras", label: "Blossom & fruit" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 8, min: 2, max: 30, unit: "m", group: "size" },
        { id: "crownWidth", label: "Crown width", type: "number", default: 6, min: "=height * 0.18", max: "=height * 1.5", unit: "m", group: "size" },
        { id: "crownStart", label: "Clear trunk", type: "number", default: 0.3, min: 0.1, max: 0.65, group: "size", description: "Share of the height that is bare trunk." },
        { id: "trunkRadius", label: "Trunk radius", type: "number", default: 0.26, min: "=height * 0.012 + 0.02", max: "=height * 0.07 + 0.05", unit: "m", group: "trunk" },
        { id: "flare", label: "Root flare", type: "number", default: 0.7, min: 0, max: 2, group: "trunk" },
        { id: "lean", label: "Lean", type: "number", default: 2, min: 0, max: 25, unit: "°", group: "trunk" },
        { id: "sway", label: "Sway", type: "number", default: 0.3, min: 0, max: 1, group: "trunk", description: "How much the trunk snakes on its way up." },
        { id: "barkRoughness", label: "Bark roughness", type: "number", default: 0.35, min: 0, max: 1, group: "trunk" },
        { id: "crownShape", label: "Crown shape", type: "enum", default: "round", options: ["round", "spreading", "columnar", "conical", "vase"], optionLabels: ["Round", "Spreading", "Columnar", "Conical", "Vase"], group: "crown" },
        { id: "branchCount", label: "Branches", type: "int", default: 9, min: 3, max: 18, group: "crown" },
        { id: "twigs", label: "Twigs per branch", type: "int", default: 2, min: 0, max: 4, group: "crown" },
        { id: "branchThickness", label: "Branch thickness", type: "number", default: 0.34, min: 0.12, max: 0.7, group: "crown" },
        { id: "branchAngle", label: "Branch rise", type: "number", default: 40, min: 15, max: 75, unit: "°", group: "crown" },
        { id: "branchArch", label: "Branch arch", type: "number", default: 0.15, min: 0, max: 0.6, group: "crown" },
        { id: "weeping", label: "Weeping", type: "number", default: 0, min: 0, max: 1, group: "crown", description: "How far the branch tips sag." },
        { id: "irregularity", label: "Irregularity", type: "number", default: 0.35, min: 0, max: 1, group: "crown" },
        leafShapeParam("leaves"),
        { id: "leafHabit", label: "Leaf habit", type: "enum", default: "flat", options: ["flat", "outward"], optionLabels: ["Flat on the crown", "Pointing outward"], group: "leaves" },
        { id: "leafSize", label: "Leaf size", type: "number", default: 0.8, min: 0.05, max: 1.8, unit: "m", group: "leaves" },
        { id: "leavesPerClump", label: "Foliage density", type: "int", default: 40, min: 3, max: treeCap, group: "leaves", description: "Leaves in the clump at each branch tip." },
        { id: "clumpSize", label: "Clump size", type: "number", default: 1.5, min: 0.15, max: "=crownWidth * 0.45 + 0.5", unit: "m", group: "leaves" },
        { id: "canopyMass", label: "Canopy body", type: "number", default: 0.6, min: 0, max: 1, group: "leaves", description: "A soft mass of foliage behind the leaves at each tip (0 leaves them see-through)." },
        { id: "leafCurl", label: "Leaf curl", type: "number", default: 25, min: 0, max: 90, unit: "°", group: "leaves" },
        { id: "leafFold", label: "Leaf fold", type: "number", default: 14, min: 0, max: 50, unit: "°", group: "leaves" },
        { id: "leafDroop", label: "Leaf droop", type: "number", default: 0.3, min: 0, max: 1, group: "leaves" },
        { id: "leafScatter", label: "Leaf scatter", type: "number", default: 30, min: 0, max: 80, unit: "°", group: "leaves", description: "How far each leaf wanders from pointing straight out." },
        { id: "leafVariety", label: "Size variety", type: "number", default: 0.3, min: 0, max: 0.6, group: "leaves" },
        { id: "secondShare", label: "Second colour share", type: "number", default: 0, min: 0, max: 1, group: "leaves", description: "Share of leaves in the second finish (autumn turning, copper beech)." },
        { id: "extra", label: "Extra", type: "enum", default: "none", options: ["none", "fruit", "blossom"], optionLabels: ["None", "Fruit", "Blossom"], group: "extras" },
        { id: "extraCount", label: "Per clump", type: "int", default: 6, min: 1, max: fruitCap, group: "extras", visibleIf: "=extra != 'none'" },
        { id: "extraSize", label: "Size", type: "number", default: 0.12, min: 0.03, max: 0.5, unit: "m", group: "extras", visibleIf: "=extra != 'none'" },
        { id: "barkFinish", label: "Bark", type: "material", default: "bark.oak", materials: ["bark"], group: "materials" },
        { id: "leafFinish", label: "Leaves", type: "material", default: "leaf.fresh", materials: ["leaf"], group: "materials" },
        { id: "secondFinish", label: "Second leaf colour", type: "material", default: "leaf.gold", materials: ["leaf"], group: "materials", visibleIf: "=secondShare > 0" },
        { id: "extraFinish", label: "Blossom / fruit", type: "material", default: "fruit.red", materials: ["fruit", "petal"], group: "materials", visibleIf: "=extra != 'none'" },
        { id: "seed", label: "Seed", type: "seed", default: 11, group: "materials", variation: 0 },
    ],
    derived: {
        crownBase: "=height * crownStart",
        crownH: "=height - crownBase",
        crownR: "=crownWidth / 2",
        leaderH: "=height * 0.97",
        ...SHAPE_DERIVED,
    },
    rules: [
        { check: "=clumpSize < crownWidth * 0.6 + 0.5", message: "The leaf clumps are bigger than the crown." },
    ],
    regions: {
        bark: { label: "Bark", material: "=barkFinish" },
        leaf: { label: "Leaves", material: "=leafFinish" },
        canopy: { label: "Canopy body", material: "=leafFinish", shade: 0.7, pattern: "mass" },
        leaf2: { label: "Second leaf colour", material: "=secondFinish" },
        extra: { label: "Blossom / fruit", material: "=extraFinish" },
    },
    presets: [
        { name: "Summer oak", values: { height: 9, crownWidth: 9, crownStart: 0.28, crownShape: "spreading", trunkRadius: 0.4, flare: 1, lean: 3, sway: 0.5, branchCount: 11, branchThickness: 0.38, branchArch: 0.22, leafShape: "ovate", leafSize: 0.45, leavesPerClump: 22, clumpSize: 1.6, leafFinish: "leaf.deep", barkFinish: "bark.oak" } },
        { name: "Silver birch", values: { height: 9, crownWidth: 4, crownStart: 0.34, crownShape: "round", trunkRadius: 0.13, flare: 0.3, lean: 5, sway: 0.5, branchCount: 8, twigs: 2, branchThickness: 0.3, branchAngle: 55, weeping: 0.25, leafShape: "serrated", leafSize: 0.26, leavesPerClump: 18, clumpSize: 0.85, leafFinish: "leaf.spring", barkFinish: "bark.birch", irregularity: 0.5 } },
        { name: "Autumn maple", values: { height: 8, crownWidth: 7, crownShape: "round", trunkRadius: 0.28, branchCount: 10, leafShape: "maple", leafSize: 0.5, leavesPerClump: 16, clumpSize: 1.3, leafFinish: "leaf.red", secondShare: 0.45, secondFinish: "leaf.orange", barkFinish: "bark.grey" } },
        { name: "Weeping willow", values: { height: 9, crownWidth: 9, crownStart: 0.22, crownShape: "spreading", trunkRadius: 0.34, flare: 1.2, lean: 6, sway: 0.6, branchCount: 14, twigs: 3, branchAngle: 52, branchArch: 0.55, weeping: 1, leafHabit: "outward", leafShape: "narrow", leafSize: 1.1, leavesPerClump: 22, clumpSize: 1.3, leafCurl: 20, leafDroop: 1, leafScatter: 10, canopyMass: 0.05, leafFinish: "leaf.spring", barkFinish: "bark.grey" } },
        { name: "Cherry blossom", values: { height: 6, crownWidth: 6.5, crownStart: 0.3, crownShape: "spreading", trunkRadius: 0.2, sway: 0.5, lean: 6, branchCount: 11, branchThickness: 0.36, leafShape: "ovate", leafSize: 0.28, leavesPerClump: 10, clumpSize: 1.05, leafFinish: "leaf.fresh", extra: "blossom", extraCount: 12, extraSize: 0.18, extraFinish: "petal.blush", barkFinish: "bark.cherry" } },
        { name: "Lombardy poplar", values: { height: 16, crownWidth: 3.8, crownStart: 0.14, crownShape: "columnar", trunkRadius: 0.3, flare: 0.5, lean: 0, sway: 0.1, branchCount: 13, twigs: 2, branchAngle: 62, leafShape: "round", leafSize: 0.34, leavesPerClump: 22, clumpSize: 1.2, leafFinish: "leaf.olive", barkFinish: "bark.grey" } },
        { name: "Apple tree", values: { height: 5, crownWidth: 5.5, crownStart: 0.28, crownShape: "round", trunkRadius: 0.2, sway: 0.5, lean: 4, branchCount: 9, leafShape: "elliptic", leafSize: 0.3, leavesPerClump: 20, clumpSize: 1, leafFinish: "leaf.fresh", extra: "fruit", extraCount: 5, extraSize: 0.15, extraFinish: "fruit.red", barkFinish: "bark.dark" } },
        { name: "Old olive", values: { height: 4.5, crownWidth: 5, crownStart: 0.2, crownShape: "vase", trunkRadius: 0.32, flare: 1.4, lean: 12, sway: 1, barkRoughness: 0.9, branchCount: 8, branchThickness: 0.42, branchAngle: 50, leafShape: "narrow", leafSize: 0.22, leavesPerClump: 36, clumpSize: 0.9, leafCurl: 12, leafFinish: "leaf.silver", barkFinish: "bark.grey", extra: "fruit", extraCount: 5, extraSize: 0.06, extraFinish: "fruit.plum" } },
    ],
    nodes: [
        { id: "trunkPath", type: "path.points", output: false, points: trunkPoints, smooth: 5 },
        { id: "trunkFine", type: "path.resample", output: false, path: "@trunkPath", count: 24 },
        { id: "trunkRaw", type: "mesh.sweep", output: false, path: "@trunkFine", radius: "=trunkRadius", sides: 12, taper: 0.16, flare: "=flare" },
        { id: "trunk", type: "deform.noise", mesh: "@trunkRaw", amount: "=trunkRadius * 0.28 * barkRoughness", frequency: "=1.6 / max(0.3, trunkRadius * 4)", octaves: 3, seed: "=seed", region: "bark" },
        { id: "branches", type: "mesh.branches", ...branchInputs, sides: 6, region: "bark" },
        { id: "tips", type: "points.branchTips", output: false, ...branchInputs, sides: 6 },
        {
            id: "leaf", type: "mesh.leaf", output: false, length: "=leafSize", width: "=leafSize * leafRatio", widest: "=leafWidest", fullness: "=leafFull", stalk: "=leafSize * 0.14",
            fold: "=leafFold", curl: "=leafCurl", teeth: "=leafTeeth", toothDepth: 0.14, lobes: "=leafLobes", lobeDepth: 0.55, rows: 4,
        },
        {
            id: "leaves", type: "instance.scatter", mesh: "@leaf", centers: "@tips", count: "=round(leavesPerClump * (1 - secondShare))", volume: "sphere",
            size: ["=clumpSize", "=clumpSize * 0.85", "=clumpSize"], hollow: 0.72, orient: "=leafHabit == 'flat' ? 'surface' : 'outward'", spread: "=leafHabit == 'flat' ? leafScatter * 2 : leafScatter", droop: "=leafDroop",
            scaleMin: "=1 - leafVariety", scaleMax: "=1 + leafVariety * 0.5", roll: 30, minY: "=leafSize * 0.6", seed: "=seed * 3 + 1", region: "leaf",
        },
        {
            id: "leaves2", type: "instance.scatter", when: "=secondShare > 0", mesh: "@leaf", centers: "@tips", count: "=round(leavesPerClump * secondShare)", volume: "sphere",
            size: ["=clumpSize", "=clumpSize * 0.85", "=clumpSize"], hollow: 0.72, orient: "=leafHabit == 'flat' ? 'surface' : 'outward'", spread: "=leafHabit == 'flat' ? leafScatter * 2 : leafScatter", droop: "=leafDroop",
            scaleMin: "=1 - leafVariety", scaleMax: "=1 + leafVariety * 0.5", roll: 30, minY: "=leafSize * 0.6", seed: "=seed * 3 + 2", region: "leaf2",
        },
        { id: "blobBase", type: "mesh.icosphere", output: false, when: "=canopyMass > 0.02", radius: 1, subdivisions: 2 },
        { id: "blob", type: "deform.noise", output: false, when: "=canopyMass > 0.02", mesh: "@blobBase", amount: 0.38, frequency: 1.3, octaves: 3, seed: "=seed", radial: true },
        {
            id: "canopy", type: "instance.scatter", when: "=canopyMass > 0.02", mesh: "@blob", centers: "@tips", count: 1, volume: "sphere",
            size: [0, 0, 0], orient: "up", spread: 0, scaleMin: "=clumpSize * (0.35 + 0.5 * canopyMass)", scaleMax: "=clumpSize * (0.4 + 0.55 * canopyMass)", roll: 180, seed: "=seed * 3 + 5", region: "canopy",
        },
        { id: "fruit", type: "mesh.icosphere", output: false, when: "=extra == 'fruit'", radius: "=extraSize / 2", subdivisions: 1 },
        { id: "petal", type: "mesh.leaf", output: false, when: "=extra == 'blossom'", length: "=extraSize", width: "=extraSize * 0.9", widest: 0.55, fullness: 0.55, fold: 8, curl: 25, rows: 3, half: 1 },
        { id: "petalTilt", type: "geo.transform", output: false, when: "=extra == 'blossom'", mesh: "@petal", rotate: [-70, 0, 0] },
        { id: "blossom", type: "instance.radial", output: false, when: "=extra == 'blossom'", mesh: "@petalTilt", count: 5 },
        {
            id: "fruits", type: "instance.scatter", when: "=extra == 'fruit'", mesh: "@fruit", centers: "@tips", count: "=extraCount", volume: "sphere",
            size: ["=clumpSize * 0.95", "=clumpSize * 0.8", "=clumpSize * 0.95"], hollow: 0.85, orient: "outward", spread: 20, droop: 0, scaleMin: 0.8, scaleMax: 1.2, roll: 180, seed: "=seed * 3 + 7", region: "extra",
        },
        {
            id: "blossoms", type: "instance.scatter", when: "=extra == 'blossom'", mesh: "@blossom", centers: "@tips", count: "=extraCount", volume: "sphere",
            size: ["=clumpSize * 1.05", "=clumpSize * 0.9", "=clumpSize * 1.05"], hollow: 0.8, orient: "outward", spread: 25, droop: 0, scaleMin: 0.75, scaleMax: 1.25, roll: 180, seed: "=seed * 3 + 9", region: "extra",
        },
    ] as NodeDef[],
    limits: { maxSize: 70, minSize: 0.5, maxTriangles: 100000, floorTolerance: 0.04 },
};

export default tree;
