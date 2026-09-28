import type { ObjectDef, NodeDef } from "../mesha_object";

/** A tuft or patch of grass: curved blades springing from a disc, some dry, with optional wildflowers. */

const grass: ObjectDef = {
    id: "nature.grass",
    name: "Grass",
    category: "Nature",
    tags: ["grass", "tuft", "blades", "meadow", "lawn", "reeds", "wheat", "sedge", "weeds", "wildflowers", "ground cover", "foliage", "plant", "nature", "landscape"],
    description: "A tuft or patch of grass blades, with dry blades and wildflowers.",
    featured: ["bladeCount", "height", "radius", "bend", "dryShare", "flowers", "leafFinish", "seed"],
    groups: [
        { id: "patch", label: "Patch" },
        { id: "blades", label: "Blades" },
        { id: "flowers", label: "Wildflowers" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "radius", label: "Radius", type: "number", default: 0.3, min: 0.04, max: "=0.06 + sqrt(bladeCount) * 0.11", unit: "m", group: "patch" },
        { id: "bladeCount", label: "Blades", type: "int", default: 100, min: 8, max: 320, group: "patch" },
        { id: "height", label: "Height", type: "number", default: 0.34, min: 0.04, max: 1.6, unit: "m", group: "patch" },
        { id: "heightVariety", label: "Height variety", type: "number", default: 0.45, min: 0, max: 0.85, group: "patch" },
        { id: "clumping", label: "Clumping", type: "number", default: 0.4, min: 0, max: 1, group: "patch", description: "How tightly blades gather toward the middle." },
        { id: "bladeWidth", label: "Blade width", type: "number", default: 0.019, min: "=height * 0.02 + 0.001", max: "=height * 0.14 + 0.006", unit: "m", group: "blades" },
        { id: "bend", label: "Bend", type: "number", default: 55, min: 0, max: "=150 - lean * 1.6", unit: "°", group: "blades", description: "How far blades arch over at the tip." },
        { id: "lean", label: "Outward lean", type: "number", default: 22, min: 0, max: 60, unit: "°", group: "blades" },
        { id: "fold", label: "Blade fold", type: "number", default: 32, min: 0, max: 70, unit: "°", group: "blades" },
        { id: "sharpness", label: "Tip sharpness", type: "number", default: 1.3, min: 0.6, max: 3, group: "blades" },
        { id: "dryShare", label: "Dry blades", type: "number", default: 0.12, min: 0, max: 1, group: "blades", description: "Share of blades in the dry finish." },
        { id: "flowers", label: "Flowers", type: "int", default: 0, min: 0, max: 12, group: "flowers" },
        { id: "flowerSize", label: "Flower size", type: "number", default: 0.35, min: 0.1, max: 1.2, group: "flowers", visibleIf: "=flowers > 0", description: "Relative to the grass height." },
        { id: "flowerFinish", label: "Petals", type: "material", default: "petal.yellow", materials: ["petal"], group: "materials", visibleIf: "=flowers > 0" },
        { id: "leafFinish", label: "Blades", type: "material", default: "leaf.spring", materials: ["leaf"], group: "materials" },
        { id: "dryFinish", label: "Dry blades", type: "material", default: "leaf.dry", materials: ["leaf"], group: "materials", visibleIf: "=dryShare > 0" },
        { id: "seed", label: "Seed", type: "seed", default: 6, group: "materials", variation: 0 },
    ],
    derived: {
        greenCount: "=round(bladeCount * (1 - dryShare))",
        dryCount: "=bladeCount - greenCount",
    },
    regions: {
        blades: { label: "Blades", material: "=leafFinish" },
        dry: { label: "Dry blades", material: "=dryFinish" },
        petals: { label: "Petals", material: "=flowerFinish" },
        stem: { label: "Stems", material: "stem.green" },
        center: { label: "Flower centers", material: "flower.gold" },
        flowerLeaves: { label: "Flower leaves", material: "=leafFinish" },
    },
    presets: [
        { name: "Lawn tuft", values: {} },
        { name: "Tall meadow", values: { radius: 0.5, bladeCount: 180, height: 0.85, heightVariety: 0.5, bend: 75, lean: 26, bladeWidth: 0.024, dryShare: 0.25, leafFinish: "leaf.olive", dryFinish: "leaf.dry", flowers: 5, flowerSize: 0.25, flowerFinish: "petal.white" } },
        { name: "Clipped lawn", values: { radius: 0.22, bladeCount: 120, height: 0.1, heightVariety: 0.2, bend: 35, lean: 15, bladeWidth: 0.012, dryShare: 0, leafFinish: "leaf.fresh", clumping: 0.1 } },
        { name: "Dry savanna", values: { radius: 0.4, bladeCount: 150, height: 0.7, heightVariety: 0.4, bend: 85, dryShare: 0.85, leafFinish: "leaf.olive", dryFinish: "leaf.dry", bladeWidth: 0.017 } },
        { name: "Marsh reeds", values: { radius: 0.35, bladeCount: 60, height: 1.4, heightVariety: 0.3, bend: 45, lean: 14, bladeWidth: 0.04, fold: 45, dryShare: 0.1, leafFinish: "leaf.sage", clumping: 0.7 } },
        { name: "Wildflower patch", values: { radius: 0.6, bladeCount: 140, height: 0.4, flowers: 9, flowerSize: 0.45, flowerFinish: "petal.magenta", dryShare: 0.05 } },
    ],
    nodes: [
        {
            id: "bladeMesh", type: "mesh.leaf", output: false, length: "=height", width: "=bladeWidth", widest: 0.22, fullness: "=sharpness", fold: "=fold", curl: "=bend", rows: 8, half: 1,
        },
        {
            id: "bladesGreen", type: "geo.transform", repeat: "=greenCount", when: "=greenCount > 0", mesh: "@bladeMesh",
            at: [
                "=cos(index * 2.39996) * radius * pow((index + 0.5) / greenCount, 0.5 + clumping * 0.9)",
                0,
                "=sin(index * 2.39996) * radius * pow((index + 0.5) / greenCount, 0.5 + clumping * 0.9)",
            ],
            rotate: ["=-(lean * (0.3 + 0.7 * rand(index, 1)))", "=rand(index, 2) * 360", 0],
            scale: "=1 - heightVariety * rand(index, 3)",
            region: "blades",
        },
        {
            id: "bladesDry", type: "geo.transform", repeat: "=dryCount", when: "=dryCount > 0", mesh: "@bladeMesh",
            at: [
                "=cos(index * 2.39996 + 1) * radius * pow((index + 0.5) / dryCount, 0.5 + clumping * 0.9)",
                0,
                "=sin(index * 2.39996 + 1) * radius * pow((index + 0.5) / dryCount, 0.5 + clumping * 0.9)",
            ],
            rotate: ["=-(lean * (0.3 + 0.7 * rand(index, 5)) + 6)", "=rand(index, 6) * 360", 0],
            scale: "=(1 - heightVariety * rand(index, 7)) * 0.95",
            region: "dry",
        },
        {
            id: "wild", type: "object", object: "nature.flower", repeat: "=flowers", when: "=flowers > 0",
            params: {
                height: "=height * (1.05 + rand(index, 8) * 0.5)", headSize: "=height * flowerSize * 0.4", stemThickness: "=max(0.002, height * 0.012)",
                leaves: 0, basal: 0, bend: 0.1, nod: 14, petals: 9, openness: 80, petalWidth: 0.3, centerSize: 0.32, petalFinish: "=flowerFinish", seed: "=seed * 7 + index",
            },
            at: [
                "=cos(index * 2.39996 + 2) * radius * 0.75 * sqrt((index + 0.5) / flowers)",
                0,
                "=sin(index * 2.39996 + 2) * radius * 0.75 * sqrt((index + 0.5) / flowers)",
            ],
            rotate: [0, "=index * 60", 0],
        },
    ] as NodeDef[],
    limits: { maxSize: 6, minSize: 0.05, maxTriangles: 60000, floorTolerance: 0.08 },
};

export default grass;
