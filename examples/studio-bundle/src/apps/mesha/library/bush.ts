import type { ObjectDef, NodeDef } from "../mesha_object";
import { leafShapeParam, SHAPE_DERIVED } from "./tree";

/**
 * A shrub, three ways: natural (a spray of stems ending in leaf clumps), a clipped globe or a
 * hedge block. Leaves lie over the body, and flowers or berries can dot the surface.
 */

const bush: ObjectDef = {
    id: "nature.bush",
    name: "Bush",
    category: "Nature",
    tags: ["bush", "shrub", "hedge", "boxwood", "topiary", "hydrangea", "rose bush", "berry bush", "blueberry", "foliage", "plant", "garden", "nature", "landscape"],
    description: "A natural shrub, clipped globe or hedge, with leaves, flowers and berries.",
    featured: ["form", "width", "height", "leafShape", "leafFinish", "blooms", "seed"],
    groups: [
        { id: "size", label: "Size & form" },
        { id: "leaves", label: "Leaves" },
        { id: "blooms", label: "Flowers & berries" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "form", label: "Form", type: "enum", default: "natural", options: ["natural", "globe", "hedge"], optionLabels: ["Natural shrub", "Clipped globe", "Hedge"], group: "size" },
        { id: "width", label: "Width", type: "number", default: 1.6, min: 0.3, max: 8, unit: "m", group: "size" },
        { id: "height", label: "Height", type: "number", default: 1.2, min: "=max(0.2, width * 0.25)", max: 4, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 0.8, min: 0.2, max: 3, unit: "m", group: "size", visibleIf: "=form == 'hedge'" },
        { id: "squareness", label: "Squareness", type: "number", default: 0.5, min: 0, max: 1, group: "size", visibleIf: "=form == 'hedge'", description: "0 is a rounded loaf; 1 a crisp box." },
        { id: "stems", label: "Stems", type: "int", default: 8, min: 4, max: 20, group: "size", visibleIf: "=form == 'natural'" },
        { id: "branchAngle", label: "Stem rise", type: "number", default: 55, min: 20, max: 80, unit: "°", group: "size", visibleIf: "=form == 'natural'" },
        { id: "weeping", label: "Weeping", type: "number", default: 0.1, min: 0, max: 1, group: "size", visibleIf: "=form == 'natural'" },
        { id: "irregularity", label: "Irregularity", type: "number", default: 0.4, min: 0, max: 1, group: "size" },
        leafShapeParam("leaves", "elliptic"),
        { id: "leafSize", label: "Leaf size", type: "number", default: 0.2, min: 0.02, max: 0.5, unit: "m", group: "leaves" },
        { id: "leafCount", label: "Foliage density", type: "int", default: 40, min: 6, max: "=form == 'natural' ? max(6, floor(1500 / (stems * 3 + 1) / leafCost)) : max(6, floor(2400 / leafCost))", group: "leaves", description: "Leaves per clump (natural) or over the whole body." },
        { id: "clumpSize", label: "Clump size", type: "number", default: 0.5, min: 0.1, max: "=width * 0.4 + 0.2", unit: "m", group: "leaves", visibleIf: "=form == 'natural'" },
        { id: "bodyMass", label: "Body fullness", type: "number", default: 0.85, min: 0, max: 1, group: "leaves", description: "A soft mass behind the leaves so the shrub reads as full." },
        { id: "leafCurl", label: "Leaf curl", type: "number", default: 22, min: 0, max: 80, unit: "°", group: "leaves" },
        { id: "leafFold", label: "Leaf fold", type: "number", default: 14, min: 0, max: 50, unit: "°", group: "leaves" },
        { id: "leafScatter", label: "Leaf scatter", type: "number", default: 40, min: 0, max: 90, unit: "°", group: "leaves" },
        { id: "blooms", label: "Flowers / berries", type: "enum", default: "none", options: ["none", "flowers", "berries"], optionLabels: ["None", "Flowers", "Berries"], group: "blooms" },
        { id: "bloomCount", label: "Count", type: "int", default: 40, min: 1, max: 260, group: "blooms", visibleIf: "=blooms != 'none'" },
        { id: "bloomSize", label: "Size", type: "number", default: 0.08, min: 0.02, max: 0.3, unit: "m", group: "blooms", visibleIf: "=blooms != 'none'" },
        { id: "leafFinish", label: "Leaves", type: "material", default: "leaf.fresh", materials: ["leaf"], group: "materials" },
        { id: "bloomFinish", label: "Flowers / berries", type: "material", default: "petal.pink", materials: ["petal", "fruit"], group: "materials", visibleIf: "=blooms != 'none'" },
        { id: "stemFinish", label: "Stems", type: "material", default: "stem.woody", materials: ["stem", "bark"], group: "materials", visibleIf: "=form == 'natural'" },
        { id: "seed", label: "Seed", type: "seed", default: 9, group: "materials", variation: 0 },
    ],
    derived: {
        ...SHAPE_DERIVED,
        cx: "=width / 2",
        tipCount: "=stems * 3 + 1",
    },
    regions: {
        stem: { label: "Stems", material: "=stemFinish" },
        leaf: { label: "Leaves", material: "=leafFinish" },
        body: { label: "Body", material: "=leafFinish", shade: 0.7, pattern: "mass" },
        bloom: { label: "Flowers / berries", material: "=bloomFinish" },
    },
    presets: [
        { name: "Garden shrub", values: {} },
        { name: "Boxwood globe", values: { form: "globe", width: 1.1, height: 1, leafShape: "round", leafSize: 0.12, leafCount: 320, bodyMass: 1, leafFinish: "leaf.deep", leafScatter: 60 } },
        { name: "Privet hedge", values: { form: "hedge", width: 3, height: 1.4, depth: 0.7, squareness: 0.8, leafShape: "elliptic", leafSize: 0.14, leafCount: 900, leafFinish: "leaf.forest" } },
        { name: "Hydrangea", values: { width: 1.5, height: 1.1, leafShape: "ovate", leafSize: 0.24, blooms: "flowers", bloomCount: 34, bloomSize: 0.16, bloomFinish: "petal.lavender", leafFinish: "leaf.fresh", clumpSize: 0.45 } },
        { name: "Rose bush", values: { width: 1.2, height: 1.1, stems: 12, leafShape: "serrated", leafSize: 0.2, leafCount: 16, blooms: "flowers", bloomCount: 22, bloomSize: 0.1, bloomFinish: "petal.red", leafFinish: "leaf.deep", clumpSize: 0.4 } },
        { name: "Blueberry bush", values: { width: 1.3, height: 1.4, leafShape: "ovate", leafSize: 0.14, blooms: "berries", bloomCount: 60, bloomSize: 0.05, bloomFinish: "fruit.plum", leafFinish: "leaf.copper", stems: 12 } },
        { name: "Autumn burning bush", values: { width: 1.8, height: 1.5, leafShape: "ovate", leafSize: 0.18, leafFinish: "leaf.crimson", weeping: 0.25 } },
    ],
    nodes: [
        { id: "trunkPath", type: "path.points", output: false, points: [[0, 0, 0], [0, "=height * 0.2", 0]] },
        {
            id: "stemsMesh", type: "mesh.branches", when: "=form == 'natural'", trunk: "@trunkPath", count: "=stems", crownBase: "=height * 0.12", crownHeight: "=height * 0.88", crownRadius: "=cx * 0.7",
            envelope: "round", angle: "=branchAngle", droop: "=weeping", arch: 0.2, radius: "=max(0.006, width * 0.012)", taper: 0.3, twigs: 2, twigLength: 0.5, twigSpread: 45,
            jitter: "=irregularity", minTipY: "=clumpSize", seed: "=seed * 5 + 3", sides: 5, region: "stem",
        },
        {
            id: "tips", type: "points.branchTips", output: false, when: "=form == 'natural'", trunk: "@trunkPath", count: "=stems", crownBase: "=height * 0.12", crownHeight: "=height * 0.88", crownRadius: "=cx * 0.7",
            envelope: "round", angle: "=branchAngle", droop: "=weeping", arch: 0.2, radius: "=max(0.006, width * 0.012)", taper: 0.3, twigs: 2, twigLength: 0.5, twigSpread: 45,
            jitter: "=irregularity", minTipY: "=clumpSize", seed: "=seed * 5 + 3", sides: 5,
        },
        { id: "blobBase", type: "mesh.icosphere", output: false, when: "=bodyMass > 0.02 && form != 'hedge'", radius: 1, subdivisions: 2 },
        { id: "blobShape", type: "deform.noise", output: false, when: "=bodyMass > 0.02 && form != 'hedge'", mesh: "@blobBase", amount: "=form == 'globe' ? 0.05 : 0.32", frequency: 1.4, octaves: 3, seed: "=seed", radial: true },
        {
            id: "clumps", type: "instance.scatter", when: "=bodyMass > 0.02 && form == 'natural'", mesh: "@blobShape", centers: "@tips", count: 1, volume: "sphere", size: [0, 0, 0],
            orient: "up", spread: 0, scaleMin: "=clumpSize * (0.28 + 0.4 * bodyMass)", scaleMax: "=clumpSize * (0.32 + 0.44 * bodyMass)", roll: 180, seed: "=seed * 3 + 5", region: "body",
        },
        {
            id: "globeBody", type: "geo.transform", when: "=form == 'globe' && bodyMass > 0.02", mesh: "@blobShape",
            at: [0, "=height / 2", 0], scale: ["=width / 2 * (0.6 + 0.4 * bodyMass)", "=height / 2 * (0.6 + 0.4 * bodyMass)", "=width / 2 * (0.6 + 0.4 * bodyMass)"], region: "body",
        },
        {
            id: "hedgeBox", type: "mesh.box", output: false, when: "=form == 'hedge'", size: ["=width", "=height", "=depth"],
            radius: "=min(width, height, depth) * 0.5 * (1 - squareness) * 0.95 + 0.01", segments: 3, divisions: [10, 5, 4],
        },
        {
            id: "hedgeBody", type: "deform.noise", when: "=form == 'hedge'", mesh: "@hedgeBox", amount: "=min(height, depth) * 0.045", frequency: "=3 / max(0.4, min(height, depth))", octaves: 3, seed: "=seed",
            at: [0, "=height / 2", 0], region: "body",
        },
        {
            id: "leafMesh", type: "mesh.leaf", output: false, length: "=leafSize", width: "=leafSize * leafRatio", widest: "=leafWidest", fullness: "=leafFull", stalk: "=leafSize * 0.14",
            fold: "=leafFold", curl: "=leafCurl", teeth: "=leafTeeth", toothDepth: 0.14, lobes: "=leafLobes", lobeDepth: 0.55, rows: 3,
        },
        {
            id: "tipLeaves", type: "instance.scatter", when: "=form == 'natural'", mesh: "@leafMesh", centers: "@tips", count: "=leafCount", volume: "sphere",
            size: ["=clumpSize", "=clumpSize * 0.85", "=clumpSize"], hollow: 0.8, orient: "surface", spread: "=leafScatter * 2", droop: 0.2, scaleMin: 0.7, scaleMax: 1.2, roll: 30, minY: "=leafSize", seed: "=seed * 3 + 1", region: "leaf",
        },
        {
            id: "globeLeaves", type: "instance.scatter", when: "=form == 'globe'", mesh: "@leafMesh", centers: [[0, "=height / 2", 0]], count: "=leafCount", volume: "sphere",
            size: ["=width / 2 * 0.98", "=height / 2 * 0.98", "=width / 2 * 0.98"], hollow: 0.9, orient: "surface", spread: "=leafScatter * 2", droop: 0.15, scaleMin: 0.7, scaleMax: 1.2, roll: 30, minY: "=leafSize", seed: "=seed * 3 + 2", region: "leaf",
        },
        {
            id: "hedgeLeaves", type: "instance.scatter", when: "=form == 'hedge'", mesh: "@leafMesh", centers: [[0, "=height / 2", 0]], count: "=leafCount", volume: "box",
            size: ["=width / 2", "=height / 2", "=depth / 2"], hollow: 0.92, orient: "surface", spread: "=leafScatter * 2", droop: 0.1, scaleMin: 0.7, scaleMax: 1.2, roll: 30, minY: "=leafSize", seed: "=seed * 3 + 4", region: "leaf",
        },
        { id: "berry", type: "mesh.icosphere", output: false, when: "=blooms != 'none'", radius: "=bloomSize / 2", subdivisions: 1 },
        { id: "petal", type: "mesh.leaf", output: false, when: "=blooms == 'flowers'", length: "=bloomSize * 0.5", width: "=bloomSize * 0.5", widest: 0.55, fullness: 0.6, fold: 10, curl: 25, rows: 3, half: 1 },
        { id: "blossom", type: "instance.rosette", output: false, when: "=blooms == 'flowers'", mesh: "@petal", count: 5, layers: 1, open: 75, openStep: 0, scaleStep: 1, lift: 0, jitter: 0.2, seed: "=seed" },
        {
            id: "blooms", type: "instance.scatter", when: "=blooms != 'none'", mesh: { if: "=blooms == 'flowers'", then: "@blossom", else: "@berry" },
            centers: { if: "=form == 'natural'", then: "@tips", else: [[0, "=height / 2", 0]] }, count: "=form == 'natural' ? max(1, round(bloomCount / tipCount)) : bloomCount", volume: "sphere",
            size: { if: "=form == 'natural'", then: ["=clumpSize * 1.05", "=clumpSize * 0.9", "=clumpSize * 1.05"], else: ["=width / 2 * 1.02", "=height / 2 * 1.02", "=(form == 'hedge' ? depth : width) / 2 * 1.02"] },
            hollow: 0.9, orient: "outward", spread: 25, droop: 0, scaleMin: 0.8, scaleMax: 1.2, roll: 180, minY: "=bloomSize", seed: "=seed * 3 + 8", region: "bloom",
        },
    ] as NodeDef[],
    limits: { maxSize: 14, minSize: 0.1, maxTriangles: 90000, floorTolerance: 0.03 },
};

export default bush;
