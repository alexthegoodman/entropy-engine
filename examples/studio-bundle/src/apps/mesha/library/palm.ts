import type { ObjectDef, NodeDef } from "../mesha_object";

/**
 * A palm: a ringed, leaning trunk (a stack of short bevelled cones following its curve) and a crown of
 * arching pinnate fronds, or fan leaves on long stalks, with optional coconuts or dates.
 */

const xAt = (f: string) => `(bend * height * 0.14 * ${f} * ${f} + tan(rad(lean)) * height * ${f})`;
const ringT = "(index / rings)";

const palm: ObjectDef = {
    id: "nature.palm",
    name: "Palm Tree",
    category: "Nature",
    tags: ["palm", "palm tree", "coconut", "date palm", "fan palm", "tropical", "beach", "island", "tree", "fronds", "foliage", "plant", "nature", "landscape"],
    description: "Coconut, date or fan palm: a ringed curving trunk and a crown of arching fronds.",
    featured: ["height", "frondStyle", "fronds", "frondLength", "arch", "lean", "leafFinish", "seed"],
    groups: [
        { id: "size", label: "Size" },
        { id: "trunk", label: "Trunk" },
        { id: "crown", label: "Crown" },
        { id: "fronds", label: "Fronds" },
        { id: "extras", label: "Fruit" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 8, min: 1.5, max: 25, unit: "m", group: "size" },
        { id: "trunkRadius", label: "Trunk radius", type: "number", default: 0.2, min: "=height * 0.012 + 0.02", max: "=height * 0.09 + 0.05", unit: "m", group: "trunk" },
        { id: "flare", label: "Base swelling", type: "number", default: 0.5, min: 0, max: 1.5, group: "trunk" },
        { id: "lean", label: "Lean", type: "number", default: 8, min: 0, max: 30, unit: "°", group: "trunk" },
        { id: "bend", label: "Curve", type: "number", default: 0.5, min: 0, max: 1.5, group: "trunk", description: "How much the trunk bows as it climbs." },
        { id: "rings", label: "Trunk rings", type: "int", default: 26, min: 6, max: 40, group: "trunk" },
        { id: "frondStyle", label: "Frond style", type: "enum", default: "pinnate", options: ["pinnate", "fan"], optionLabels: ["Pinnate (coconut, date)", "Fan (washingtonia)"], group: "crown" },
        { id: "fronds", label: "Fronds", type: "int", default: 14, min: 5, max: 26, group: "crown" },
        { id: "frondLength", label: "Frond length", type: "number", default: 3.4, min: 0.4, max: "=height * 0.8 + 1", unit: "m", group: "crown" },
        { id: "arch", label: "Arch", type: "number", default: 75, min: 10, max: 150, unit: "°", group: "crown", description: "How far each frond bends over toward its tip." },
        { id: "crownLift", label: "Crown lift", type: "number", default: 0.5, min: 0, max: 1, group: "crown", description: "Low is a drooping skirt; high a shuttlecock." },
        { id: "irregularity", label: "Irregularity", type: "number", default: 0.3, min: 0, max: 1, group: "crown" },
        { id: "pairs", label: "Leaflet pairs", type: "int", default: 28, min: 8, max: "=min(40, max(8, floor((45000 / fronds - 100) / 16)))", group: "fronds", visibleIf: "=frondStyle == 'pinnate'" },
        { id: "leafletLength", label: "Leaflet length", type: "number", default: 0.3, min: 0.08, max: 0.5, group: "fronds", visibleIf: "=frondStyle == 'pinnate'" },
        { id: "leafletWidth", label: "Leaflet width", type: "number", default: 0.13, min: 0.03, max: 0.4, group: "fronds", visibleIf: "=frondStyle == 'pinnate'" },
        { id: "leafletAngle", label: "Leaflet sweep", type: "number", default: 58, min: 25, max: 90, unit: "°", group: "fronds", visibleIf: "=frondStyle == 'pinnate'" },
        { id: "leafletDroop", label: "Leaflet droop", type: "number", default: 40, min: 0, max: 100, unit: "°", group: "fronds", visibleIf: "=frondStyle == 'pinnate'" },
        { id: "lobes", label: "Fan segments", type: "int", default: 14, min: 5, max: 24, group: "fronds", visibleIf: "=frondStyle == 'fan'" },
        { id: "fruitKind", label: "Fruit", type: "enum", default: "none", options: ["none", "coconuts", "dates"], optionLabels: ["None", "Coconuts", "Dates"], group: "extras" },
        { id: "fruitCount", label: "Count", type: "int", default: 7, min: 1, max: 24, group: "extras", visibleIf: "=fruitKind != 'none'" },
        { id: "trunkFinish", label: "Trunk", type: "material", default: "bark.palm", materials: ["bark"], group: "materials" },
        { id: "leafFinish", label: "Fronds", type: "material", default: "leaf.fresh", materials: ["leaf"], group: "materials" },
        { id: "fruitFinish", label: "Fruit", type: "material", default: "fruit.coconut", materials: ["fruit"], group: "materials", visibleIf: "=fruitKind != 'none'" },
        { id: "seed", label: "Seed", type: "seed", default: 3, group: "materials", variation: 0 },
    ],
    derived: {
        topX: `=${xAt("1")}`,
        crownY: "=height * 0.985",
        ringH: "=height / rings",
    },
    regions: {
        trunk: { label: "Trunk", material: "=trunkFinish" },
        fronds: { label: "Fronds", material: "=leafFinish" },
        fruit: { label: "Fruit", material: "=fruitFinish" },
    },
    presets: [
        { name: "Coconut palm", values: { height: 9, lean: 14, bend: 0.8, fronds: 15, frondLength: 3.6, arch: 85, pairs: 26, leafFinish: "leaf.fresh", fruitKind: "coconuts", fruitCount: 8, fruitFinish: "fruit.coconut" } },
        { name: "Date palm", values: { height: 10, trunkRadius: 0.3, flare: 0.3, lean: 3, bend: 0.2, fronds: 20, frondLength: 3.2, arch: 55, crownLift: 0.8, leafletLength: 0.26, leafletWidth: 0.11, pairs: 32, leafletAngle: 48, leafletDroop: 15, leafFinish: "leaf.olive", trunkFinish: "bark.oak", fruitKind: "dates", fruitCount: 14, fruitFinish: "fruit.orange" } },
        { name: "Fan palm", values: { height: 12, trunkRadius: 0.22, flare: 0.2, lean: 2, bend: 0.15, fronds: 16, frondLength: 3, frondStyle: "fan", arch: 60, crownLift: 0.3, leafFinish: "leaf.olive", trunkFinish: "bark.grey" } },
        { name: "Beach palm", values: { height: 6, trunkRadius: 0.16, lean: 24, bend: 1.1, fronds: 12, frondLength: 2.8, arch: 100, crownLift: 0.2, pairs: 22, leafFinish: "leaf.sage" } },
        { name: "Young sago", values: { height: 2.2, trunkRadius: 0.16, flare: 1, lean: 0, bend: 0.1, rings: 10, fronds: 18, frondLength: 1.7, arch: 70, crownLift: 0.45, pairs: 22, leafFinish: "leaf.deep" } },
    ],
    nodes: [
        {
            id: "trunkRings", type: "mesh.cone", repeat: "=rings",
            bottomRadius: `=trunkRadius * (1 - 0.32 * ${ringT}) * (1 + flare * pow(2.718, -9 * ${ringT}))`,
            topRadius: `=trunkRadius * (1 - 0.32 * ((index + 1) / rings)) * (1 + flare * pow(2.718, -9 * ((index + 1) / rings))) * 0.99`,
            height: "=ringH * 1.06", segments: 12, bevel: "=ringH * 0.16",
            at: [`=${xAt(ringT)}`, `=height * ${ringT}`, 0],
            rotate: [0, 0, `=-deg(atan2(2 * bend * 0.14 * ${ringT} + tan(rad(lean)), 1))`],
            region: "trunk",
        },
        {
            id: "pinnate", type: "mesh.frond", repeat: "=fronds", when: "=frondStyle == 'pinnate'",
            length: "=frondLength * (0.78 + 0.22 * (1 - t)) * (1 + (rand(index, 1) - 0.5) * irregularity * 0.5)",
            pairs: "=pairs", leafletLength: "=leafletLength", leafletWidth: "=leafletWidth", angle: "=leafletAngle", lift: 12, droop: "=leafletDroop", curl: "=arch * (0.8 + 0.4 * t)",
            peak: 0.4, gap: 0.16, rachis: "=max(0.006, frondLength * 0.01)", fold: 25,
            at: ["=topX", "=crownY", 0],
            rotate: ["=-90 + lerp(85 - 25 * (1 - crownLift), -25 + 40 * crownLift, pow(t, 0.75)) + (rand(index, 2) - 0.5) * irregularity * 25", "=index * 137.5 + (rand(index, 3) - 0.5) * irregularity * 30", 0],
            region: "fronds",
        },
        { id: "fanLeaf", type: "mesh.leaf", output: false, when: "=frondStyle == 'fan'", length: "=frondLength", width: "=frondLength * 0.95", widest: 0.5, stalk: "=frondLength * 0.5", lobes: "=lobes", lobeDepth: 0.72, spread: 210, fold: 12, curl: "=arch * 0.5", rows: 6 },
        {
            id: "fan", type: "geo.transform", repeat: "=fronds", when: "=frondStyle == 'fan'", mesh: "@fanLeaf",
            at: ["=topX", "=crownY", 0],
            rotate: ["=-90 + lerp(80 - 30 * (1 - crownLift), -30 + 50 * crownLift, pow(t, 0.75)) + (rand(index, 2) - 0.5) * irregularity * 25", "=index * 137.5 + (rand(index, 3) - 0.5) * irregularity * 30", 0],
            scale: "=(0.75 + 0.25 * (1 - t)) * (1 + (rand(index, 1) - 0.5) * irregularity * 0.4)",
            region: "fronds",
        },
        { id: "nut", type: "mesh.icosphere", output: false, when: "=fruitKind != 'none'", radius: "=fruitKind == 'coconuts' ? trunkRadius * 0.55 : trunkRadius * 0.16", subdivisions: 2 },
        {
            id: "fruit", type: "instance.scatter", when: "=fruitKind != 'none'", mesh: "@nut", centers: [["=topX", "=crownY - trunkRadius * 1.2", 0]], count: "=fruitCount", volume: "sphere",
            size: ["=trunkRadius * 1.5", "=trunkRadius * 0.9", "=trunkRadius * 1.5"], hollow: 0.5, orient: "random", spread: 0, droop: 0, scaleMin: 0.85, scaleMax: 1.15, roll: 180, seed: "=seed * 3 + 1", region: "fruit",
        },
    ] as NodeDef[],
    limits: { maxSize: 60, minSize: 0.5, maxTriangles: 90000, floorTolerance: 0.03 },
};

export default palm;
