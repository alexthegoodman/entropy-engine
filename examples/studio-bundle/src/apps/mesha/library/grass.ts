import type { ObjectDef } from "../mesha_object";

/** Grass: one clump or a patch of clumps, with optional plumes or flower spikes (pampas, lavender, wheat). */
const grass: ObjectDef = {
    id: "nature.grass", name: "Grass", category: "Nature",
    tags: ["grass", "tuft", "lawn", "meadow", "pampas", "ornamental grass", "reeds", "lavender", "wheat", "savanna", "plant", "foliage", "garden", "landscape", "nature", "ground cover"],
    description: "A grass tuft or a patch of clumps, from lawn to pampas plumes, dry savanna or lavender spikes.",
    featured: ["clumps", "height", "bladeWidth", "lean", "curl", "tipTint", "plumes", "grassFinish"],
    groups: [
        { id: "patch", label: "Patch" },
        { id: "blades", label: "Blades" },
        { id: "plumes", label: "Plumes" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "clumps", label: "Clumps", type: "int", default: 1, min: 1, max: 60, group: "patch" },
        { id: "patchRadius", label: "Patch radius", type: "number", default: 0.6, min: 0.1, max: 4, unit: "m", group: "patch", visibleIf: "=clumps > 1" },
        { id: "sizeVariation", label: "Clump variety", type: "number", default: 0.35, min: 0, max: 0.8, group: "patch", visibleIf: "=clumps > 1" },
        { id: "blades", label: "Blades per clump", type: "int", default: 60, min: 5, max: 220, group: "blades" },
        { id: "height", label: "Height", type: "number", default: 0.45, min: 0.04, max: 2.5, unit: "m", group: "blades" },
        { id: "heightVariation", label: "Height variety", type: "number", default: 0.45, min: 0, max: 0.9, group: "blades" },
        { id: "bladeWidth", label: "Blade width", type: "number", default: 0.012, min: 0.002, max: 0.06, unit: "m", decimals: 3, group: "blades" },
        { id: "clumpRadius", label: "Clump base", type: "number", default: 0.05, min: 0, max: 0.4, unit: "m", group: "blades" },
        { id: "lean", label: "Lean", type: "number", default: 28, min: 0, max: 60, unit: "°", group: "blades" },
        { id: "curl", label: "Curl", type: "number", default: 55, min: 0, max: 150, unit: "°", group: "blades" },
        { id: "tipTint", label: "Tip color", type: "number", default: 0.25, min: 0, max: 1, group: "blades", description: "How far tips turn toward the material's tint (straw on meadow grass)." },
        { id: "variety", label: "Color variety", type: "number", default: 0.4, min: 0, max: 1, group: "blades" },
        { id: "plumes", label: "Plumes", type: "int", default: 0, min: 0, max: 30, group: "plumes", description: "Stalks with plumes or flower spikes above the blades." },
        { id: "plumeStyle", label: "Plume style", type: "enum", default: "feather", options: ["feather", "spike", "ear"], optionLabels: ["Feathery (pampas)", "Flower spike (lavender)", "Seed ear (wheat)"], group: "plumes", visibleIf: "=plumes > 0" },
        { id: "plumeHeight", label: "Stalk height", type: "number", default: 1.4, min: 1, max: 2.5, group: "plumes", visibleIf: "=plumes > 0", description: "Relative to the blades." },
        { id: "plumeLength", label: "Plume length", type: "number", default: 0.3, min: 0.1, max: 0.6, group: "plumes", visibleIf: "=plumes > 0", description: "Relative to the blades." },
        { id: "grassFinish", label: "Blades", type: "material", default: "grass.meadow", materials: ["grass", "leaf"], group: "materials" },
        { id: "plumeFinish", label: "Plumes", type: "material", default: "flower.cream", materials: ["flower", "grass.dry"], group: "materials", visibleIf: "=plumes > 0" },
        { id: "seed", label: "Seed", type: "seed", default: 3, group: "materials", variation: 0 },
    ],
    derived: {
        // However big the patch, a few thousand blades in all.
        bladeCount: "=max(5, min(blades, floor(4500 / clumps)))",
        plumeCount: "=min(plumes, max(1, floor(400 / clumps)))",
        stalkH: "=height * plumeHeight",
        plumeL: "=height * plumeLength",
    },
    rules: [
        { check: "=bladeWidth < height * 0.2", message: "Blades this wide on grass this short look like leaves." },
    ],
    regions: {
        grass: { label: "Blades", material: "=grassFinish" },
        plumes: { label: "Plumes", material: "=plumeFinish" },
    },
    presets: [
        { name: "Meadow tuft", values: {} },
        { name: "Lawn patch", values: { clumps: 50, patchRadius: 0.45, blades: 60, height: 0.1, heightVariation: 0.4, bladeWidth: 0.004, clumpRadius: 0.06, lean: 30, curl: 35, tipTint: 0.1, grassFinish: "grass.lawn", seed: 8 } },
        { name: "Pampas grass", values: { blades: 160, height: 1.2, heightVariation: 0.4, bladeWidth: 0.012, clumpRadius: 0.2, lean: 30, curl: 110, tipTint: 0.5, plumes: 11, plumeStyle: "feather", plumeHeight: 1.7, plumeLength: 0.4, grassFinish: "grass.meadow", plumeFinish: "flower.cream", seed: 5 } },
        { name: "Dry savanna", values: { clumps: 9, patchRadius: 1.2, blades: 70, height: 0.7, heightVariation: 0.5, bladeWidth: 0.008, lean: 35, curl: 70, tipTint: 0.8, grassFinish: "grass.dry", plumes: 3, plumeStyle: "ear", plumeHeight: 1.25, plumeLength: 0.2, plumeFinish: "grass.dry", seed: 12 } },
        { name: "Lavender", values: { clumps: 5, patchRadius: 0.35, blades: 70, height: 0.32, heightVariation: 0.25, bladeWidth: 0.004, clumpRadius: 0.07, lean: 25, curl: 15, tipTint: 0, grassFinish: "grass.lavender", plumes: 24, plumeStyle: "spike", plumeHeight: 1.9, plumeLength: 0.28, plumeFinish: "flower.purple", seed: 2 } },
        { name: "Reeds", values: { clumps: 4, patchRadius: 0.5, blades: 40, height: 1.8, heightVariation: 0.35, bladeWidth: 0.018, clumpRadius: 0.1, lean: 12, curl: 40, tipTint: 0.35, grassFinish: "grass.meadow", plumes: 8, plumeStyle: "ear", plumeHeight: 1.1, plumeLength: 0.12, plumeFinish: "flower.center", seed: 17 } },
    ],
    nodes: [
        {
            id: "clump", type: "plant.blades", output: false, count: "=bladeCount", height: "=height", heightVariation: "=heightVariation", width: "=bladeWidth",
            radius: "=clumpRadius", lean: "=lean", curl: "=curl", tipTint: "=tipTint", tintVariation: "=variety", segments: "=height > 0.6 ? 5 : 4", seed: "=seed",
            shape: "blade", region: "grass",
        },
        // A plume on its stalk, standing up: the stalk is the leaf's petiole.
        {
            id: "plume", type: "mesh.leaf", output: false, shape: "=plumeStyle == 'ear' ? 'lanceolate' : 'spray'",
            length: "=plumeL", width: "=plumeL * (plumeStyle == 'feather' ? 0.38 : plumeStyle == 'spike' ? 0.22 : 0.16)", fold: 60,
            curl: "=plumeStyle == 'feather' ? 35 : 8", petiole: "=stalkH - plumeL", segments: 5, lobes: "=plumeStyle == 'feather' ? 12 : 7", rotate: [-90, 0, 0],
        },
        // Plumes turn about their stalk, so the flat blade reads from every side.
        { id: "plumePair", type: "geo.join", output: false, meshes: ["@plume", "@plumeCross"] },
        { id: "plumeCross", type: "geo.transform", output: false, mesh: "@plume", rotate: [0, 90, 0] },
        { id: "plumeSet", type: "instance.scatter", output: false, when: "=plumes > 0", mesh: "@plumePair", count: "=plumeCount", radius: "=clumpRadius * 0.7 + height * 0.04", seed: "=seed + 5", scaleMin: 0.85, scaleMax: 1.1, tilt: "=12 + lean * 0.3", falloff: 0.3, tintVariation: 0.4, region: "plumes" },
        { id: "tuft", type: "geo.join", output: false, meshes: ["@clump", "@plumeSet"] },
        {
            id: "patch", type: "instance.scatter", mesh: "@tuft", count: "=clumps", radius: "=clumps > 1 ? patchRadius : 0", seed: "=seed",
            scaleMin: "=1 - sizeVariation", scaleMax: 1, tilt: "=clumps > 1 ? 6 : 0", falloff: 0.2, tintVariation: "=variety * 0.4",
        },
    ],
    limits: { maxSize: 10, minSize: 0.02, maxTriangles: 200000 },
};

export default grass;
