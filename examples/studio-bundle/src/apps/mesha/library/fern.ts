import type { ObjectDef } from "../mesha_object";

/** A fern: a rosette of arching pinnate fronds with coiled fiddleheads, on the ground or atop a tree-fern trunk. */
const fern: ObjectDef = {
    id: "nature.fern", name: "Fern", category: "Nature",
    tags: ["fern", "tree fern", "fiddlehead", "bracken", "boston fern", "maidenhair", "bird's nest", "plant", "foliage", "forest", "nature", "garden", "undergrowth"],
    description: "Boston, maidenhair, bird's nest or tree fern: arching fronds with leaflets, coiled fiddleheads and an optional trunk.",
    featured: ["fronds", "frondLength", "arch", "leafletShape", "fiddleheads", "trunkHeight", "leafFinish"],
    groups: [
        { id: "fronds", label: "Fronds" },
        { id: "leaflets", label: "Leaflets" },
        { id: "trunk", label: "Trunk" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "fronds", label: "Fronds", type: "int", default: 14, min: 3, max: 36, group: "fronds" },
        { id: "frondLength", label: "Frond length", type: "number", default: 0.7, min: 0.12, max: 3, unit: "m", group: "fronds" },
        { id: "arch", label: "Arch", type: "number", default: 80, min: 5, max: 200, unit: "°", group: "fronds" },
        { id: "rise", label: "Rise", type: "number", default: 55, min: 5, max: 85, unit: "°", group: "fronds", description: "How steeply fronds leave the crown." },
        { id: "spread", label: "Length spread", type: "number", default: 0.3, min: 0, max: 0.7, group: "fronds" },
        { id: "fiddleheads", label: "Fiddleheads", type: "int", default: 3, min: 0, max: 8, group: "fronds" },
        { id: "leaflets", label: "Leaflets per side", type: "int", default: 22, min: 0, max: 50, group: "leaflets", description: "0 gives each frond one undivided blade (bird's nest fern)." },
        { id: "leafletShape", label: "Leaflet shape", type: "enum", default: "lanceolate", options: ["lanceolate", "ovate", "round", "lobed", "blade"], optionLabels: ["Narrow", "Ovate", "Round (maidenhair)", "Lobed", "Strap"], group: "leaflets", visibleIf: "=leaflets > 0" },
        { id: "leafletLength", label: "Leaflet length", type: "number", default: 0.2, min: 0.04, max: 0.45, group: "leaflets", visibleIf: "=leaflets > 0" },
        { id: "leafletWidth", label: "Leaflet width", type: "number", default: 0.26, min: 0.08, max: 1.2, group: "leaflets", visibleIf: "=leaflets > 0" },
        { id: "leafletAngle", label: "Leaflet angle", type: "number", default: 72, min: 30, max: 100, unit: "°", group: "leaflets", visibleIf: "=leaflets > 0" },
        { id: "bladeWidth", label: "Blade width", type: "number", default: 0.16, min: 0.05, max: 0.4, group: "leaflets", visibleIf: "=leaflets == 0" },
        { id: "trunkHeight", label: "Trunk height", type: "number", default: 0, min: 0, max: 5, unit: "m", group: "trunk", description: "Above 0 lifts the crown on a tree-fern trunk." },
        { id: "trunkRadius", label: "Trunk radius", type: "number", default: 0.12, min: 0.04, max: 0.35, unit: "m", group: "trunk", visibleIf: "=trunkHeight > 0" },
        { id: "leafFinish", label: "Fronds", type: "material", default: "leaf.fern", materials: ["leaf"], group: "materials" },
        { id: "stemFinish", label: "Stems", type: "material", default: "stem.green", materials: ["stem"], group: "materials" },
        { id: "trunkFinish", label: "Trunk", type: "material", default: "bark.dark", materials: ["bark"], group: "materials", visibleIf: "=trunkHeight > 0" },
        { id: "seed", label: "Seed", type: "seed", default: 6, group: "materials", variation: 0 },
    ],
    derived: {
        top: "=trunkHeight > 0 ? trunkHeight : frondLength * 0.02",
        stemR: "=frondLength * 0.012",
    },
    rules: [
        { check: "=trunkHeight == 0 || trunkRadius < trunkHeight * 0.3", message: "The trunk is stouter than it is tall." },
        { check: "=trunkHeight > 0 || arch < 140 || rise > 45", message: "Fronds this curled droop into the ground." },
    ],
    regions: {
        leaves: { label: "Fronds", material: "=leafFinish" },
        stem: { label: "Stems", material: "=stemFinish" },
        trunk: { label: "Trunk", material: "=trunkFinish" },
    },
    presets: [
        { name: "Boston fern", values: {} },
        { name: "Maidenhair", values: { fronds: 12, frondLength: 0.45, arch: 110, rise: 60, leaflets: 14, leafletShape: "round", leafletLength: 0.13, leafletWidth: 1, leafletAngle: 80, fiddleheads: 2, leafFinish: "leaf.spring", stemFinish: "stem.brown", seed: 3 } },
        { name: "Bird's nest", values: { fronds: 16, frondLength: 0.6, arch: 60, rise: 60, spread: 0.35, leaflets: 0, bladeWidth: 0.2, fiddleheads: 0, leafFinish: "leaf.tropical", seed: 8 } },
        { name: "Tree fern", values: { fronds: 18, frondLength: 2, arch: 90, rise: 40, spread: 0.2, leaflets: 30, leafletLength: 0.2, leafletWidth: 0.22, trunkHeight: 2.6, trunkRadius: 0.16, fiddleheads: 4, leafFinish: "leaf.fern", seed: 14 } },
        { name: "Bracken", values: { fronds: 7, frondLength: 1, arch: 45, rise: 70, spread: 0.45, leaflets: 16, leafletShape: "lobed", leafletLength: 0.26, leafletWidth: 0.35, leafletAngle: 60, fiddleheads: 1, leafFinish: "leaf.gold", stemFinish: "stem.brown", seed: 21 } },
    ],
    nodes: [
        { id: "trunkPath", type: "path.points", when: "=trunkHeight > 0", points: [[0, 0, 0], ["=trunkHeight * 0.03", "=trunkHeight * 0.5", 0], [0, "=trunkHeight", 0]], smooth: 6, output: false },
        { id: "trunk", type: "plant.stalk", when: "=trunkHeight > 0", path: "@trunkPath", radius: "=trunkRadius * 1.25", tipRadius: "=trunkRadius", sides: 14, rings: "=trunkHeight / (trunkRadius * 0.7)", ringDepth: 0.08, flare: 0.5, bark: 1.2, seed: "=seed", region: "trunk" },
        {
            id: "fronds", type: "plant.frond", output: false, repeat: "=fronds", when: "=leaflets > 0",
            length: "=frondLength * (1 - spread * rand(index, 1)) * lerp(1, 0.8, t)", arch: "=arch * lerp(0.8, 1.2, rand(index, 2))", unfurl: 1,
            leaflets: "=leaflets", leafletLength: "=leafletLength", leafletWidth: "=leafletWidth", leafletAngle: "=leafletAngle", leafletDroop: 12,
            shape: "=leafletShape", stalk: "=trunkHeight > 0 ? 0.12 : 0.18", stemRadius: "=stemR", tintVariation: 0.35, seed: "=seed * 13 + index",
            stemRegion: "stem", leafRegion: "leaves",
            rotate: ["=-rise * lerp(1.1, 0.75, t) + rand(index, 3) * 10", "=index * 137.5", 0],
            at: [0, "=top", 0],
        },
        // Undivided blades (bird's nest): one broad strap per frond, rippled by its own curl.
        {
            id: "blades", type: "mesh.leaf", output: false, repeat: "=fronds", when: "=leaflets == 0",
            shape: "lanceolate", length: "=frondLength * (1 - spread * rand(index, 1)) * lerp(1, 0.75, t)", width: "=frondLength * bladeWidth",
            fold: 30, curl: "=arch * lerp(0.7, 1.1, rand(index, 2))", segments: 10, petiole: "=frondLength * 0.05",
            rotate: ["=-rise * lerp(1.15, 0.8, t) + rand(index, 3) * 10", "=index * 137.5", 0],
            at: [0, "=top", 0], region: "leaves",
        },
        // Fiddleheads: young fronds still coiled, standing in the middle.
        {
            id: "fiddleheads", type: "plant.frond", output: false, repeat: "=fiddleheads",
            length: "=frondLength * lerp(0.28, 0.45, rand(index, 4))", arch: -20, unfurl: "=lerp(0.02, 0.25, rand(index, 5))",
            leaflets: "=max(4, round(leaflets * 0.6))", leafletLength: "=leafletLength * 0.5", leafletWidth: "=leafletWidth", leafletAngle: 30, leafletDroop: -25,
            shape: "=leaflets > 0 ? leafletShape : 'lanceolate'", stalk: 0.35, stemRadius: "=stemR * 0.9", tintVariation: 0.2, seed: "=seed * 17 + index",
            stemRegion: "stem", leafRegion: "leaves",
            rotate: ["=-80 + rand(index, 6) * 20", "=index * 131 + 20", 0],
            at: ["=cos(index * 2.1) * frondLength * 0.03", "=top", "=sin(index * 2.1) * frondLength * 0.03"],
        },
        // Fronds that arch back down to the ground rest on it.
        { id: "crown", type: "deform.clamp", mesh: { if: "=leaflets > 0", then: "@fronds", else: "@blades" }, min: 0, give: 0.002 },
        { id: "young", type: "deform.clamp", mesh: "@fiddleheads", min: 0, give: 0.002 },
    ],
    limits: { maxSize: 12, minSize: 0.08, maxTriangles: 160000 },
};

export default fern;
