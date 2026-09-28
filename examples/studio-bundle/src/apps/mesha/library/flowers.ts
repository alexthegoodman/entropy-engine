import type { ObjectDef } from "../mesha_object";

/** Flowers: one bloom on its stem, or a bed of them - daisies, tulips, poppies, sunflowers, cosmos. */
const flowers: ObjectDef = {
    id: "nature.flowers", name: "Flowers", category: "Nature",
    tags: ["flower", "flowers", "flower bed", "daisy", "tulip", "poppy", "sunflower", "cosmos", "wildflowers", "bloom", "petals", "plant", "garden", "meadow", "nature"],
    description: "A single flower or a bed of them: petals in rings or cups, a seed head, a bending stem and leaves.",
    featured: ["count", "petals", "cup", "headSize", "stemHeight", "petalFinish", "centerFinish"],
    groups: [
        { id: "bed", label: "Bed" },
        { id: "bloom", label: "Bloom" },
        { id: "stem", label: "Stem & leaves" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "count", label: "Flowers", type: "int", default: 9, min: 1, max: 80, group: "bed" },
        { id: "spread", label: "Bed radius", type: "number", default: 0.3, min: 0.05, max: 2.5, unit: "m", group: "bed", visibleIf: "=count > 1" },
        { id: "sizeVariety", label: "Size variety", type: "number", default: 0.3, min: 0, max: 0.6, group: "bed", visibleIf: "=count > 1" },
        { id: "headSize", label: "Bloom size", type: "number", default: 0.075, min: 0.02, max: 0.4, unit: "m", group: "bloom" },
        { id: "petals", label: "Petals", type: "int", default: 16, min: 3, max: 36, group: "bloom" },
        { id: "petalRings", label: "Petal rings", type: "int", default: 1, min: 1, max: 3, group: "bloom" },
        { id: "petalShape", label: "Petal shape", type: "enum", default: "petal", options: ["petal", "round", "ovate", "lanceolate"], optionLabels: ["Spoon", "Round", "Ovate", "Narrow"], group: "bloom" },
        { id: "petalWidth", label: "Petal width", type: "number", default: 0.3, min: 0.12, max: 1.2, group: "bloom" },
        { id: "cup", label: "Cup", type: "number", default: 12, min: -20, max: 85, unit: "°", group: "bloom", description: "How far petals rise: flat daisies to closed tulip cups." },
        { id: "petalCurl", label: "Petal curl", type: "number", default: 15, min: -60, max: 90, unit: "°", group: "bloom" },
        { id: "centerSize", label: "Center size", type: "number", default: 0.28, min: 0.05, max: 0.7, group: "bloom" },
        { id: "stemHeight", label: "Stem height", type: "number", default: 0.35, min: 0.05, max: 2.2, unit: "m", group: "stem" },
        { id: "bend", label: "Stem bend", type: "number", default: 0.12, min: 0, max: 0.5, group: "stem" },
        { id: "nod", label: "Nod", type: "number", default: 15, min: 0, max: 80, unit: "°", group: "stem", description: "How far the bloom tips over." },
        { id: "leaves", label: "Leaves", type: "int", default: 2, min: 0, max: 6, group: "stem" },
        { id: "leafStyle", label: "Leaf style", type: "enum", default: "lanceolate", options: ["lanceolate", "blade", "ovate", "lobed"], optionLabels: ["Narrow", "Strap (tulip)", "Ovate", "Lobed"], group: "stem", visibleIf: "=leaves > 0" },
        { id: "leafLength", label: "Leaf length", type: "number", default: 0.35, min: 0.1, max: 0.9, group: "stem", visibleIf: "=leaves > 0", description: "Relative to the stem." },
        { id: "petalFinish", label: "Petals", type: "material", default: "flower.white", materials: ["flower"], group: "materials" },
        { id: "centerFinish", label: "Center", type: "material", default: "flower.pollen", materials: ["flower.pollen", "flower.center", "flower.yellow", "flower.white"], group: "materials" },
        { id: "stemFinish", label: "Stem", type: "material", default: "stem.green", materials: ["stem"], group: "materials" },
        { id: "leafFinish", label: "Leaves", type: "material", default: "leaf.green", materials: ["leaf"], group: "materials", visibleIf: "=leaves > 0" },
        { id: "seed", label: "Seed", type: "seed", default: 10, group: "materials", variation: 0 },
    ],
    derived: {
        h: "=stemHeight",
        sway: "=stemHeight * bend",
        centerR: "=headSize * 0.5 * centerSize",
        petalL: "=headSize * 0.5 * (1 - centerSize * 0.6)",
        stemR: "=max(0.0015, headSize * 0.035 + stemHeight * 0.004)",
    },
    rules: [
        { check: "=headSize < stemHeight * 0.9", message: "The bloom is too heavy for its stem." },
        { check: "=petals * petalWidth < 26 || cup > 30", message: "Petals this wide and many pile into each other (fewer or narrower petals)." },
    ],
    regions: {
        petals: { label: "Petals", material: "=petalFinish" },
        center: { label: "Center", material: "=centerFinish" },
        stem: { label: "Stem", material: "=stemFinish" },
        leaves: { label: "Leaves", material: "=leafFinish" },
    },
    presets: [
        { name: "Daisies", values: {} },
        { name: "Red tulips", values: { count: 12, spread: 0.3, headSize: 0.09, petals: 6, petalShape: "ovate", petalWidth: 0.75, cup: 78, petalCurl: -18, centerSize: 0.15, stemHeight: 0.42, bend: 0.05, nod: 4, leaves: 2, leafStyle: "blade", leafLength: 0.55, petalFinish: "flower.red", centerFinish: "flower.center", seed: 4 } },
        { name: "Poppies", values: { count: 14, spread: 0.45, headSize: 0.1, petals: 4, petalShape: "round", petalWidth: 1.1, cup: 40, petalCurl: 10, centerSize: 0.22, stemHeight: 0.5, bend: 0.2, nod: 10, leaves: 2, leafStyle: "lobed", leafLength: 0.25, petalFinish: "flower.red", centerFinish: "flower.center", seed: 7 } },
        { name: "Sunflower", values: { count: 1, headSize: 0.34, petals: 24, petalRings: 2, petalShape: "lanceolate", petalWidth: 0.3, cup: 8, petalCurl: 20, centerSize: 0.6, stemHeight: 1.6, bend: 0.06, nod: 62, leaves: 5, leafStyle: "ovate", leafLength: 0.15, petalFinish: "flower.yellow", centerFinish: "flower.center", seed: 2 } },
        { name: "Pink cosmos", values: { count: 18, spread: 0.5, headSize: 0.11, petals: 8, petalShape: "ovate", petalWidth: 0.55, cup: 8, petalCurl: 5, centerSize: 0.22, stemHeight: 0.7, bend: 0.25, nod: 20, leaves: 3, leafStyle: "lanceolate", leafLength: 0.2, petalFinish: "flower.pink", centerFinish: "flower.pollen", seed: 13 } },
        { name: "Snowdrops", values: { count: 16, spread: 0.25, headSize: 0.05, petals: 3, petalShape: "ovate", petalWidth: 0.6, cup: 58, petalCurl: -10, centerSize: 0.2, stemHeight: 0.18, bend: 0.35, nod: 80, leaves: 2, leafStyle: "blade", leafLength: 0.8, petalFinish: "flower.white", centerFinish: "flower.white", leafFinish: "leaf.dark", seed: 5 } },
    ],
    nodes: [
        { id: "stemPath", type: "path.bezier", output: false, p0: [0, 0, 0], p1: [0, "=h * 0.45", 0], p2: ["=sway * 0.55", "=h * 0.85", 0], p3: ["=sway", "=h", 0], segments: 14 },
        { id: "stem", type: "plant.stalk", output: false, path: "@stemPath", radius: "=stemR", tipRadius: "=stemR * 0.75", sides: 6, region: "stem" },
        // A petal leaves the rim of the seed head and rises by `cup`.
        { id: "petal", type: "mesh.leaf", output: false, shape: "=petalShape", length: "=petalL", width: "=petalL * petalWidth", fold: 14, curl: "=petalCurl", segments: "=count * petals * petalRings > 1200 ? 3 : 4", rotate: ["=-cup", 0, 0], at: [0, 0, "=centerR * 0.7"] },
        { id: "ring", type: "instance.radial", output: false, mesh: "@petal", count: "=petals" },
        { id: "rings", type: "geo.transform", output: false, mesh: "@ring", repeat: "=petalRings", rotate: [0, "=index * 180 / petals", 0], scale: "=lerp(1, 0.82, index / 2)", at: [0, "=index * petalL * 0.06", 0], region: "petals" },
        { id: "eye", type: "mesh.sphere", output: false, radius: "=centerR", segments: 16, rings: 8, scale: [1, "=cup > 50 ? 1.4 : 0.45", 1], at: [0, "=cup > 50 ? centerR * 0.6 : 0", 0], region: "center" },
        { id: "head", type: "geo.join", output: false, meshes: ["@rings", "@eye"] },
        { id: "headPlaced", type: "geo.transform", output: false, mesh: "@head", rotate: [0, 0, "=-nod"], at: ["=sway", "=h", 0] },
        {
            id: "leaf", type: "mesh.leaf", output: false, repeat: "=leaves", shape: "=leafStyle", length: "=h * leafLength * lerp(1, 0.7, t)",
            width: "=h * leafLength * (leafStyle == 'blade' ? 0.16 : leafStyle == 'lobed' ? 0.45 : 0.3) * lerp(1, 0.7, t)", fold: 25, curl: "=leafStyle == 'blade' ? 50 : 35", segments: 5, lobes: 3,
            rotate: ["=leafStyle == 'blade' ? -62 : -35", "=index * 137.5 + 30", 0],
            at: ["=sway * t * t * 0.4", "=h * (leafStyle == 'blade' ? 0.01 : lerp(0.12, 0.6, t))", 0], region: "leaves",
        },
        { id: "flower", type: "geo.join", output: false, meshes: ["@stem", "@headPlaced", "@leaf"] },
        {
            id: "bed", type: "instance.scatter", mesh: "@flower", count: "=count", radius: "=count > 1 ? spread : 0", seed: "=seed",
            scaleMin: "=count > 1 ? 1 - sizeVariety : 1", scaleMax: 1, tilt: "=count > 1 ? 10 : 0", falloff: 0.15, tintVariation: 0.5,
        },
    ],
    limits: { maxSize: 6, minSize: 0.04, maxTriangles: 200000 },
};

export default flowers;
