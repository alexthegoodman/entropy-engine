import type { ObjectDef } from "../mesha_object";

/**
 * A shrub: a natural multi-stemmed bush, or a clipped ball, hedge or cone covered in leaves (the
 * clipped body itself shaded as deep foliage so no gaps show), optionally in bloom.
 */
const shrub: ObjectDef = {
    id: "nature.shrub", name: "Shrub", category: "Nature",
    tags: ["shrub", "bush", "hedge", "boxwood", "topiary", "hydrangea", "azalea", "rose bush", "holly", "berries", "plant", "foliage", "garden", "landscape", "nature"],
    description: "A natural bush, or a clipped ball, hedge or cone topiary, with blossoms, mophead flowers or berries.",
    featured: ["style", "height", "width", "leafSize", "bloom", "leafFinish", "flowerFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "shape", label: "Shape" },
        { id: "leaves", label: "Leaves" },
        { id: "bloom", label: "Flowers" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "style", label: "Style", type: "enum", default: "natural", options: ["natural", "ball", "hedge", "cone"], optionLabels: ["Natural", "Clipped ball", "Clipped hedge", "Clipped cone"], group: "shape" },
        { id: "height", label: "Height", type: "number", default: 1.2, min: 0.25, max: 3.5, unit: "m", group: "size" },
        { id: "width", label: "Width", type: "number", default: 1.4, min: 0.25, max: 5, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 0.8, min: 0.25, max: 3, unit: "m", group: "size", visibleIf: "=style == 'hedge'" },
        { id: "stems", label: "Stems", type: "int", default: 7, min: 3, max: 14, group: "shape", visibleIf: "=style == 'natural'" },
        { id: "gnarl", label: "Gnarl", type: "number", default: 0.4, min: 0, max: 1.2, group: "shape", visibleIf: "=style == 'natural'" },
        { id: "droop", label: "Arching", type: "number", default: 0.3, min: -0.5, max: 2, group: "shape", visibleIf: "=style == 'natural'" },
        { id: "standard", label: "Stem height", type: "number", default: 0, min: 0, max: 1.5, unit: "m", group: "shape", visibleIf: "=style == 'ball' || style == 'cone'", description: "Lifts a clipped ball or cone onto a bare stem (a standard)." },
        { id: "lumps", label: "Lumpiness", type: "number", default: 0.35, min: 0, max: 1, group: "shape", visibleIf: "=style != 'natural'" },
        { id: "leafShape", label: "Leaf shape", type: "enum", default: "ovate", options: ["ovate", "lanceolate", "round", "heart", "lobed"], optionLabels: ["Ovate", "Narrow", "Round", "Heart", "Lobed"], group: "leaves" },
        { id: "leafSize", label: "Leaf size", type: "number", default: 0.09, min: 0.02, max: 0.2, unit: "m", group: "leaves" },
        { id: "density", label: "Density", type: "number", default: 1, min: 0.3, max: 2, group: "leaves" },
        { id: "variety", label: "Color variety", type: "number", default: 0.5, min: 0, max: 1, group: "leaves" },
        { id: "bloom", label: "Flowers", type: "enum", default: "none", options: ["none", "blossoms", "mopheads", "berries"], optionLabels: ["None", "Blossoms", "Mopheads (hydrangea)", "Berries"], group: "bloom" },
        { id: "flowerCount", label: "Flower count", type: "int", default: 60, min: 5, max: 400, group: "bloom", visibleIf: "=bloom != 'none'", description: "Over a clipped body; on a natural bush, per 60 of these one more flower on each twig." },
        { id: "flowerSize", label: "Flower size", type: "number", default: 0.06, min: 0.015, max: 0.3, unit: "m", group: "bloom", visibleIf: "=bloom != 'none'" },
        { id: "leafFinish", label: "Leaves", type: "material", default: "leaf.dark", materials: ["leaf"], group: "materials" },
        { id: "stemFinish", label: "Stems", type: "material", default: "bark.dark", materials: ["bark"], group: "materials" },
        { id: "flowerFinish", label: "Flowers", type: "material", default: "flower.pink", materials: ["flower", "fruit"], group: "materials", visibleIf: "=bloom != 'none'" },
        { id: "seed", label: "Seed", type: "seed", default: 12, group: "materials", variation: 0 },
    ],
    derived: {
        clipped: "=style != 'natural'",
        bodyH: "=height - standard",
        bodyY: "=standard + bodyH / 2",
        d: "=style == 'hedge' ? depth : width",
        // Enough leaves to cover the clipped surface, whatever its size.
        area: "=style == 'hedge' ? 2 * (width * bodyH + depth * bodyH + width * depth) : style == 'cone' ? 3.1416 * width * 0.5 * sqrt(bodyH * bodyH + width * width * 0.25) : 3.1416 * (width * bodyH * 0.9 + width * width * 0.1)",
        surfaceLeaves: "=clamp(density * area / (leafSize * leafSize * 0.55), 150, 7000)",
        spreadAngle: "=clamp(deg(atan2(width * 0.55, height)) * 1.05, 18, 72)",
    },
    rules: [
        { check: "=!clipped || standard < height * 0.6", message: "The stem leaves too little clipped body." },
        { check: "=style != 'natural' || width < height * 3", message: "A natural bush this flat needs more stems to fill it (or clip it as a hedge)." },
    ],
    regions: {
        stems: { label: "Stems", material: "=stemFinish" },
        leaves: { label: "Leaves", material: "=leafFinish" },
        flowers: { label: "Flowers", material: "=flowerFinish" },
        centers: { label: "Flower centers", material: "flower.pollen" },
    },
    presets: [
        { name: "Garden shrub", values: {} },
        { name: "Boxwood ball", values: { style: "ball", height: 0.9, width: 1, lumps: 0.3, leafShape: "round", leafSize: 0.035, density: 1.2, leafFinish: "leaf.dark", variety: 0.4, seed: 4 } },
        { name: "Clipped hedge", values: { style: "hedge", height: 1.3, width: 3, depth: 0.8, lumps: 0.2, leafShape: "ovate", leafSize: 0.05, density: 1, leafFinish: "leaf.green", seed: 7 } },
        { name: "Hydrangea", values: { style: "natural", height: 1.1, width: 1.4, stems: 9, droop: 0.6, leafShape: "heart", leafSize: 0.13, density: 0.8, bloom: "mopheads", flowerCount: 22, flowerSize: 0.2, flowerFinish: "flower.blue", leafFinish: "leaf.green", seed: 9 } },
        { name: "Topiary cone", values: { style: "cone", height: 1.8, width: 0.8, standard: 0, lumps: 0.15, leafShape: "round", leafSize: 0.035, leafFinish: "leaf.dark", seed: 2 } },
        { name: "Holly standard", values: { style: "ball", height: 1.6, width: 0.8, standard: 0.8, lumps: 0.4, leafShape: "lobed", leafSize: 0.06, bloom: "berries", flowerCount: 90, flowerSize: 0.018, flowerFinish: "fruit.red", leafFinish: "leaf.dark", stemFinish: "bark.grey", seed: 15 } },
        { name: "Azalea in bloom", values: { style: "natural", height: 0.9, width: 1.3, stems: 10, droop: 0.1, leafShape: "lanceolate", leafSize: 0.06, bloom: "blossoms", flowerCount: 220, flowerSize: 0.075, flowerFinish: "flower.pink", leafFinish: "leaf.green", seed: 20 } },
    ],
    nodes: [
        { id: "leaf", type: "mesh.leaf", output: false, shape: "=leafShape", length: "=leafSize", width: "=leafSize * 0.62", fold: 20, curl: 25, segments: 3, lobes: 3, region: "leaves" },
        // --- Natural: a short trunk forking at once into many arching stems.
        {
            id: "bush", type: "plant.tree", when: "=!clipped",
            height: "=height", trunkRadius: "=max(0.006, height * 0.022)", levels: 3, branches: "=stems", twigs: 4, crownBase: 0.03, leader: 0,
            angle: "=spreadAngle", reach: 0.85, subReach: 0.62, crownShape: "round", radiusRatio: 0.7, gnarl: "=gnarl", droop: "=droop", lean: 0, flare: 0.2,
            sides: 7, segments: 5, seed: "=seed", leaf: "@leaf", leaves: "=round(26 * density)", leafStart: 0.1, leafAngle: 55, leafDroop: 0.15,
            leafScaleVariation: 0.3, tintVariation: "=variety", leafBudget: "=60000 * density", barkRegion: "stems",
            bloom: "@flower", blooms: "=bloom == 'none' ? 0 : clamp(round(flowerCount / 60), 1, 6)",
        },
        // --- Clipped: a lumpy body wearing a coat of leaves.
        { id: "ballBody", type: "mesh.icosphere", output: false, radius: 0.5, subdivisions: 3, scale: ["=width", "=bodyH", "=width"], at: [0, "=bodyY", 0] },
        { id: "hedgeBody", type: "mesh.box", output: false, size: ["=width", "=bodyH", "=depth"], radius: "=min(width, min(bodyH, depth)) * 0.18", segments: 3, divisions: [8, 5, 5], at: [0, "=bodyY", 0] },
        { id: "coneBody", type: "mesh.lathe", output: false, profile: [[0, 0], ["=width * 0.5", "=bodyH * 0.06"], ["=width * 0.47", "=bodyH * 0.2"], ["=width * 0.05", "=bodyH * 0.97"], [0, "=bodyH"]], segments: 40, smoothAngle: 80, at: [0, "=standard", 0] },
        { id: "bodyRaw", type: "geo.transform", output: false, mesh: { switch: "=style", cases: { hedge: "@hedgeBody", cone: "@coneBody" }, default: "@ballBody" } },
        { id: "bodyLumpy", type: "deform.noise", output: false, mesh: "@bodyRaw", amount: "=lumps * min(width, bodyH) * 0.06", frequency: "=3.5 / max(0.3, min(width, bodyH))", octaves: 3, seed: "=seed" },
        { id: "body", type: "deform.clamp", output: false, mesh: "@bodyLumpy", min: "=standard" },
        {
            id: "coat", type: "instance.onSurface", output: false, when: "=clipped", surface: "@body", mesh: "@leaf", count: "=surfaceLeaves", seed: "=seed",
            scaleMin: 0.75, scaleMax: 1.25, tilt: 30, tintVariation: "=variety", keepSurface: true, surfaceRegion: "leaves",
        },
        { id: "standardPath", type: "path.points", output: false, points: [[0, 0, 0], [0, "=standard + bodyH * 0.2", 0]] },
        { id: "standardStem", type: "plant.stalk", when: "=clipped && standard > 0.01", path: "@standardPath", radius: "=max(0.012, width * 0.03)", tipRadius: "=max(0.009, width * 0.022)", sides: 10, flare: 0.3, bark: 0.3, region: "stems" },
        // --- Flowers at the twig tips of a natural bush, or over a clipped body: blossoms (five petals and a center), mophead clusters or berries.
        { id: "petal", type: "mesh.leaf", output: false, shape: "petal", length: "=flowerSize * 0.5", width: "=flowerSize * 0.36", fold: 10, curl: -25, segments: 3, rotate: [-18, 0, 0] },
        { id: "petals", type: "instance.radial", output: false, mesh: "@petal", count: 5, region: "flowers" },
        { id: "eye", type: "mesh.sphere", output: false, radius: "=flowerSize * 0.1", segments: 8, rings: 5, scale: [1, 0.6, 1], region: "centers" },
        { id: "blossom", type: "geo.join", output: false, meshes: ["@petals", "@eye"] },
        // A mophead is a dome of small four-petalled florets.
        { id: "floretPetal", type: "mesh.leaf", output: false, shape: "round", length: "=flowerSize * 0.11", width: "=flowerSize * 0.1", fold: 8, curl: -10, segments: 2, rotate: [-8, 0, 0] },
        { id: "floret", type: "instance.radial", output: false, mesh: "@floretPetal", count: 4 },
        { id: "puffBall", type: "mesh.icosphere", output: false, radius: "=flowerSize * 0.5", subdivisions: 1, scale: [1, 0.8, 1], at: [0, "=flowerSize * 0.2", 0] },
        { id: "mophead", type: "instance.onSurface", output: false, surface: "@puffBall", mesh: "@floret", count: 34, seed: "=seed + 3", scaleMin: 0.8, scaleMax: 1.2, tilt: 5, tintVariation: 0.6, keepSurface: true, minNormalY: -0.5 },
        { id: "mopShaded", type: "geo.transform", output: false, mesh: "@mophead", region: "flowers" },
        { id: "berry", type: "mesh.sphere", output: false, radius: "=flowerSize * 0.5", segments: 10, rings: 6, at: [0, "=flowerSize * 0.4", 0] },
        { id: "berries", type: "instance.linear", output: false, mesh: "@berry", count: 3, offset: ["=flowerSize * 0.7", 0, "=flowerSize * 0.3"], region: "flowers" },
        { id: "flower", type: "geo.transform", output: false, mesh: { switch: "=bloom", cases: { mopheads: "@mopShaded", berries: "@berries" }, default: "@blossom" } },
        {
            id: "flowers", type: "instance.onSurface", output: false, when: "=bloom != 'none' && clipped", surface: "@body", mesh: "@flower", count: "=bloom == 'mopheads' ? min(flowerCount, 40) : flowerCount", seed: "=seed + 1",
            scaleMin: 0.8, scaleMax: 1.15, tilt: 6, tintVariation: 0.5, keepSurface: false, minNormalY: -0.25,
        },
        // Leaves around the foot of a clipped body rest on the ground.
        { id: "clippedCoat", type: "deform.clamp", mesh: "@coat", min: 0, give: 0.002 },
        { id: "clippedFlowers", type: "deform.clamp", mesh: "@flowers", min: 0, give: 0.002 },
    ],
    limits: { maxSize: 8, minSize: 0.2, maxTriangles: 200000 },
};

export default shrub;
