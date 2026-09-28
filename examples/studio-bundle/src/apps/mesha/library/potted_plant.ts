import type { ObjectDef } from "../mesha_object";

/**
 * A houseplant in a pot. The pot is a hollow turned vessel filled with soil; the plant composes
 * the Nature library (fern, palm, topiary, tulips) or grows a succulent rosette or snake plant here.
 */
const pottedPlant: ObjectDef = {
    id: "household.potted_plant", name: "Potted Plant", category: "Household",
    tags: ["potted plant", "houseplant", "plant pot", "planter", "succulent", "echeveria", "snake plant", "sansevieria", "fern", "palm", "topiary", "tulips", "terracotta", "indoor plant", "decor"],
    description: "A houseplant in a terracotta, glazed or concrete pot: fern, parlour palm, succulent, snake plant, topiary or tulips.",
    featured: ["plant", "potShape", "potRadius", "potHeight", "plantSize", "potFinish", "foliage"],
    groups: [
        { id: "plant", label: "Plant" },
        { id: "pot", label: "Pot" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "plant", label: "Plant", type: "enum", default: "fern", options: ["fern", "palm", "succulent", "snake", "topiary", "tulips"], optionLabels: ["Fern", "Parlour palm", "Succulent", "Snake plant", "Topiary ball", "Tulips"], group: "plant" },
        { id: "plantSize", label: "Plant size", type: "number", default: 1, min: 0.5, max: 2, group: "plant", description: "Relative to the pot." },
        { id: "leafCount", label: "Leaves", type: "int", default: 28, min: 6, max: 60, group: "plant", visibleIf: "=plant == 'succulent' || plant == 'snake'" },
        { id: "potShape", label: "Pot shape", type: "enum", default: "classic", options: ["classic", "cylinder", "bowl", "urn"], optionLabels: ["Classic rim", "Cylinder", "Bowl", "Urn"], group: "pot" },
        { id: "potRadius", label: "Pot radius", type: "number", default: 0.13, min: 0.05, max: 0.5, unit: "m", group: "pot" },
        { id: "potHeight", label: "Pot height", type: "number", default: 0.24, min: "=potRadius * 0.6", max: "=min(potRadius * 3.5, 0.9)", unit: "m", group: "pot" },
        { id: "wall", label: "Wall", type: "number", default: 0.012, min: 0.004, max: "=potRadius * 0.15", unit: "m", decimals: 3, group: "pot" },
        { id: "saucer", label: "Saucer", type: "bool", default: true, group: "pot" },
        { id: "potFinish", label: "Pot", type: "material", default: "ceramic.terracotta", materials: ["ceramic", "paint", "stone", "metal.copper", "metal.brass"], group: "materials" },
        { id: "foliage", label: "Foliage", type: "material", default: "leaf.fern", materials: ["leaf"], group: "materials" },
        { id: "flowerFinish", label: "Flowers", type: "material", default: "flower.red", materials: ["flower"], group: "materials", visibleIf: "=plant == 'tulips'" },
        { id: "seed", label: "Seed", type: "seed", default: 8, group: "materials", variation: 0 },
    ],
    derived: {
        R: "=potRadius", H: "=potHeight",
        lift: "=saucer ? potRadius * 0.1 : 0",
        topR: "=potShape == 'bowl' ? R : potShape == 'urn' ? R * 1.02 : potShape == 'cylinder' ? R : R * 1.1",
        soilY: "=lift + H * 0.88",
        soilR: "=(potShape == 'classic' ? R : topR) - wall * 1.2 - H * 0.02",
        s: "=plantSize",
    },
    rules: [
        { check: "=wall < soilR * 0.4", message: "The walls leave no room for soil." },
    ],
    regions: {
        pot: { label: "Pot", material: "=potFinish" },
        soil: { label: "Soil", material: "soil" },
        leaves: { label: "Foliage", material: "=foliage" },
        stem: { label: "Stems", material: "stem.green" },
        stems: { label: "Branches", material: "bark.dark" },
        trunk: { label: "Trunk", material: "bark.palm" },
        dead: { label: "Dead fronds", material: "stem.brown" },
        nuts: { label: "Fruit", material: "fruit.green" },
        flowers: { label: "Blossoms", material: "=flowerFinish" },
        centers: { label: "Blossom centers", material: "flower.pollen" },
        petals: { label: "Petals", material: "=flowerFinish" },
        center: { label: "Flower centers", material: "flower.center" },
    },
    presets: [
        { name: "Terracotta fern", values: {} },
        { name: "Parlour palm", values: { plant: "palm", plantSize: 1.1, potShape: "cylinder", potRadius: 0.16, potHeight: 0.3, potFinish: "ceramic.white", foliage: "leaf.dark", saucer: false, seed: 3 } },
        { name: "Succulent bowl", values: { plant: "succulent", plantSize: 1.7, leafCount: 34, potShape: "bowl", potRadius: 0.12, potHeight: 0.1, potFinish: "ceramic.speckled", foliage: "leaf.succulent", saucer: false, seed: 5 } },
        { name: "Snake plant", values: { plant: "snake", plantSize: 1.3, leafCount: 11, potShape: "cylinder", potRadius: 0.13, potHeight: 0.26, potFinish: "paint.black", foliage: "leaf.tropical", saucer: false, seed: 9 } },
        { name: "Topiary urn", values: { plant: "topiary", plantSize: 1.2, potShape: "urn", potRadius: 0.17, potHeight: 0.34, potFinish: "stone.sandstone", foliage: "leaf.dark", saucer: false, seed: 2 } },
        { name: "Tulip pot", values: { plant: "tulips", plantSize: 1, potShape: "classic", potRadius: 0.12, potHeight: 0.2, potFinish: "paint.sage", foliage: "leaf.olive", flowerFinish: "flower.yellow", seed: 6 } },
    ],
    nodes: [
        // --- The pot: a closed annular profile, so the inner wall and rim are real geometry.
        {
            id: "potProfile", type: "curve.points", output: false, fillet: "=wall * 0.45", filletSegments: 3,
            points: { switch: "=potShape", cases: {
                cylinder: [[0, 0], ["=R", 0], ["=R", "=H"], ["=R - wall", "=H"], ["=R - wall", "=wall"], [0, "=wall"]],
                bowl: [[0, 0], ["=R * 0.55", 0], ["=R * 0.86", "=H * 0.3"], ["=R", "=H * 0.75"], ["=R", "=H"], ["=R - wall", "=H"], ["=R - wall", "=H * 0.75"], ["=R * 0.86 - wall", "=H * 0.3"], ["=R * 0.55 - wall", "=wall"], [0, "=wall"]],
                urn: [[0, 0], ["=R * 0.62", 0], ["=R * 0.62", "=H * 0.06"], ["=R * 0.48", "=H * 0.14"], ["=R * 0.82", "=H * 0.45"], ["=R * 0.92", "=H * 0.84"], ["=topR", "=H * 0.9"], ["=topR", "=H"], ["=topR - wall", "=H"], ["=R * 0.92 - wall", "=H * 0.86"], ["=R * 0.82 - wall", "=H * 0.45"], ["=R * 0.48 - wall", "=H * 0.16"], [0, "=H * 0.16"]],
            }, default: [[0, 0], ["=R * 0.74", 0], ["=R", "=H * 0.8"], ["=topR", "=H * 0.8"], ["=topR", "=H"], ["=topR - wall", "=H"], ["=topR - wall", "=H * 0.84"], ["=R - wall", "=H * 0.84"], ["=R * 0.74 - wall", "=wall"], [0, "=wall"]] } },
        { id: "pot", type: "mesh.lathe", profile: "@potProfile", segments: 56, smoothAngle: 50, at: [0, "=lift", 0], region: "pot" },
        { id: "saucer", type: "mesh.cylinder", when: "=saucer", radius: "=R * (potShape == 'bowl' ? 0.8 : 1.05)", height: "=lift", segments: 48, bevel: "=lift * 0.35", region: "pot" },
        { id: "soil", type: "mesh.cylinder", radius: "=soilR", height: "=H * 0.05", segments: 40, bevel: "=H * 0.012", at: [0, "=soilY - H * 0.05", 0], region: "soil" },
        { id: "pebbles", type: "deform.noise", mesh: "@soilTop", amount: "=H * 0.012", frequency: "=6 / R", octaves: 3, seed: "=seed", at: [0, "=soilY - H * 0.02", 0], region: "soil" },
        { id: "soilTop", type: "mesh.cylinder", output: false, radius: "=soilR * 0.98", height: "=H * 0.02", segments: 40 },
        // --- The plant, standing on the soil.
        {
            id: "fern", type: "object", object: "nature.fern", when: "=plant == 'fern'", at: [0, "=soilY", 0],
            params: { fronds: 16, frondLength: "=min(R * 3.2 * s, 1.3)", arch: 95, rise: 58, leaflets: 20, leafletLength: 0.2, fiddleheads: 2, leafFinish: "=foliage", seed: "=seed" },
        },
        {
            id: "palm", type: "object", object: "nature.palm", when: "=plant == 'palm'", at: [0, "=soilY", 0], scale: "=min(H * 2.3 * s / 2, 1.1)",
            params: { height: 2, trunkRadius: 0.05, curve: 0.04, taper: 0.9, rings: 0.12, flare: 0.1, fronds: 13, rise: 60, deadFronds: 0, frondLength: 1.1, arch: 110, leaflets: 26, leafletLength: 0.2, leafletWidth: 0.12, leafletDroop: 40, coconuts: 0, frondFinish: "=foliage", stemFinish: "stem.green", seed: "=seed" },
        },
        {
            id: "topiary", type: "object", object: "nature.shrub", when: "=plant == 'topiary'", at: [0, "=soilY", 0], scale: "=min(H * 3 * s, 1.6)",
            params: { style: "ball", height: 1, width: 0.62, standard: 0.45, lumps: 0.3, leafShape: "round", leafSize: 0.028, density: 1.1, leafFinish: "=foliage", stemFinish: "bark.dark", seed: "=seed" },
        },
        {
            id: "tulips", type: "object", object: "nature.flowers", when: "=plant == 'tulips'", at: [0, "=soilY", 0],
            params: { count: 7, spread: "=soilR * 0.55", sizeVariety: 0.2, headSize: "=R * 0.75 * s", petals: 6, petalShape: "ovate", petalWidth: 0.75, cup: 78, petalCurl: -18, centerSize: 0.15, stemHeight: "=min(H * 1.25 * s, 0.9)", bend: 0.06, nod: 4, leaves: 2, leafStyle: "blade", leafLength: 0.5, petalFinish: "=flowerFinish", centerFinish: "flower.center", leafFinish: "=foliage", seed: "=seed" },
        },
        // A succulent rosette: fleshy, cupped leaves spiralling in by the golden angle, blushing at the tips.
        {
            id: "rosette", type: "mesh.leaf", when: "=plant == 'succulent'", repeat: "=leafCount",
            shape: "ovate", length: "=R * 0.8 * s * lerp(1, 0.3, t)", width: "=R * 0.5 * s * lerp(1, 0.45, t)", fold: 50, curl: "=lerp(-20, -45, t)", segments: 5, tipTint: 0.55,
            rotate: ["=-lerp(22, 78, t)", "=index * 137.508", 0], at: [0, "=soilY + t * R * 0.1 * s", 0], region: "leaves",
        },
        // A snake plant: stiff upright swords.
        {
            id: "swords", type: "plant.blades", when: "=plant == 'snake'", count: "=leafCount", height: "=min(H * 2.4 * s, 1.4)", heightVariation: 0.35, width: "=R * 0.42 * s",
            radius: "=soilR * 0.45", lean: 12, curl: 8, tipTint: 0.15, tintVariation: 0.6, segments: 6, seed: "=seed", shape: "lanceolate", at: [0, "=soilY - H * 0.02", 0], region: "leaves",
        },
    ],
    limits: { maxSize: 4, minSize: 0.05, maxTriangles: 220000 },
};

export default pottedPlant;
