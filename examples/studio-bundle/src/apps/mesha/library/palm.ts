import type { ObjectDef } from "../mesha_object";

/** A palm: a ringed, curving trunk crowned with arching pinnate fronds, coconuts and a skirt of dead fronds. */
const palm: ObjectDef = {
    id: "nature.palm", name: "Palm", category: "Nature",
    tags: ["palm", "palm tree", "coconut", "date palm", "royal palm", "tropical", "beach", "tree", "fronds", "foliage", "nature", "landscape"],
    description: "Coconut, date or royal palm: a curving ringed trunk, a crown of arching fronds, coconuts and dead fronds.",
    featured: ["height", "curve", "fronds", "frondLength", "arch", "coconuts", "frondFinish"],
    groups: [
        { id: "trunk", label: "Trunk" },
        { id: "crown", label: "Crown" },
        { id: "fronds", label: "Fronds" },
        { id: "fruit", label: "Fruit" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 7, min: 1.5, max: 22, unit: "m", group: "trunk" },
        { id: "trunkRadius", label: "Trunk radius", type: "number", default: 0.17, min: "=height * 0.01", max: "=height * 0.06", unit: "m", decimals: 2, group: "trunk" },
        { id: "curve", label: "Curve", type: "number", default: 0.14, min: 0, max: 0.45, group: "trunk", description: "How far the crown leans out, relative to the height." },
        { id: "taper", label: "Top radius", type: "number", default: 0.72, min: 0.45, max: 1.1, group: "trunk" },
        { id: "rings", label: "Ring depth", type: "number", default: 0.1, min: 0, max: 0.3, group: "trunk" },
        { id: "flare", label: "Base swell", type: "number", default: 0.5, min: 0, max: 1.2, group: "trunk" },
        { id: "fronds", label: "Fronds", type: "int", default: 16, min: 5, max: 32, group: "crown" },
        { id: "rise", label: "Crown lift", type: "number", default: 50, min: 10, max: 80, unit: "°", group: "crown", description: "How steeply the youngest fronds rise." },
        { id: "deadFronds", label: "Dead fronds", type: "int", default: 3, min: 0, max: 10, group: "crown" },
        { id: "frondLength", label: "Frond length", type: "number", default: 2.6, min: "=height * 0.12", max: "=height * 0.6", unit: "m", group: "fronds" },
        { id: "arch", label: "Arch", type: "number", default: 95, min: 15, max: 170, unit: "°", group: "fronds" },
        { id: "leaflets", label: "Leaflets", type: "int", default: 34, min: 10, max: 60, group: "fronds" },
        { id: "leafletLength", label: "Leaflet length", type: "number", default: 0.22, min: 0.08, max: 0.4, group: "fronds" },
        { id: "leafletWidth", label: "Leaflet width", type: "number", default: 0.1, min: 0.04, max: 0.3, group: "fronds" },
        { id: "leafletDroop", label: "Leaflet droop", type: "number", default: 32, min: 0, max: 70, unit: "°", group: "fronds" },
        { id: "coconuts", label: "Coconuts", type: "int", default: 5, min: 0, max: 12, group: "fruit" },
        { id: "nutSize", label: "Coconut size", type: "number", default: 0.14, min: 0.06, max: 0.25, unit: "m", group: "fruit", visibleIf: "=coconuts > 0" },
        { id: "trunkFinish", label: "Trunk", type: "material", default: "bark.palm", materials: ["bark"], group: "materials" },
        { id: "frondFinish", label: "Fronds", type: "material", default: "leaf.palm", materials: ["leaf"], group: "materials" },
        { id: "stemFinish", label: "Frond stems", type: "material", default: "stem.green", materials: ["stem"], group: "materials" },
        { id: "nutFinish", label: "Coconuts", type: "material", default: "fruit.green", materials: ["fruit"], group: "materials", visibleIf: "=coconuts > 0" },
        { id: "seed", label: "Seed", type: "seed", default: 4, group: "materials", variation: 0 },
    ],
    derived: {
        lean: "=height * curve",
        topR: "=trunkRadius * taper",
        // The crown tips with the trunk's last stretch.
        tilt: "=deg(atan2(lean * 0.65, height * 0.2)) * 0.55",
    },
    rules: [
        { check: "=frondLength < height * 0.55 || curve < 0.3", message: "Long fronds on a strongly curved trunk sweep the ground." },
    ],
    regions: {
        trunk: { label: "Trunk", material: "=trunkFinish" },
        stem: { label: "Frond stems", material: "=stemFinish" },
        leaves: { label: "Fronds", material: "=frondFinish" },
        dead: { label: "Dead fronds", material: "stem.brown" },
        nuts: { label: "Coconuts", material: "=nutFinish" },
    },
    presets: [
        { name: "Coconut palm", values: {} },
        { name: "Date palm", values: { height: 9, trunkRadius: 0.3, curve: 0.02, taper: 0.95, rings: 0.2, flare: 0.3, fronds: 30, rise: 60, deadFronds: 8, frondLength: 3.2, arch: 55, leaflets: 44, leafletLength: 0.16, leafletWidth: 0.07, leafletDroop: 20, coconuts: 0, frondFinish: "leaf.olive", seed: 11 } },
        { name: "Royal palm", values: { height: 14, trunkRadius: 0.3, curve: 0, taper: 0.8, rings: 0.03, flare: 0.8, fronds: 14, rise: 45, deadFronds: 0, frondLength: 3.6, arch: 120, leaflets: 44, leafletLength: 0.2, leafletWidth: 0.08, leafletDroop: 50, coconuts: 0, trunkFinish: "bark.grey", frondFinish: "leaf.green", seed: 2 } },
        { name: "Windswept", values: { height: 6, trunkRadius: 0.14, curve: 0.4, fronds: 12, rise: 35, frondLength: 2.2, arch: 120, leafletDroop: 45, coconuts: 3, deadFronds: 2, seed: 7 } },
        { name: "Pygmy date", values: { height: 2.2, trunkRadius: 0.1, curve: 0.05, taper: 1, rings: 0.18, flare: 0.2, fronds: 22, rise: 55, deadFronds: 0, frondLength: 1.1, arch: 100, leaflets: 40, leafletLength: 0.2, leafletWidth: 0.07, leafletDroop: 40, coconuts: 0, frondFinish: "leaf.dark", seed: 19 } },
    ],
    nodes: [
        { id: "path", type: "path.bezier", p0: [0, 0, 0], p1: [0, "=height * 0.4", 0], p2: ["=lean * 0.35", "=height * 0.8", 0], p3: ["=lean", "=height", 0], segments: 24 },
        {
            id: "trunk", type: "plant.stalk", path: "@path", radius: "=trunkRadius", tipRadius: "=topR", sides: 18,
            rings: "=rings > 0.005 ? height / (trunkRadius * 0.9) : 0", ringDepth: "=rings", flare: "=flare", bark: 0.3, seed: "=seed", region: "trunk",
        },
        // The frond bases swell into a boot where the crown sits.
        { id: "boot", type: "mesh.sphere", radius: "=topR * 1.35", segments: 18, rings: 10, scale: [1, 1.7, 1], rotate: [0, 0, "=-tilt"], at: ["=lean", "=height - topR * 0.6", 0], region: "trunk" },
        {
            id: "crown", type: "plant.frond", repeat: "=fronds",
            length: "=frondLength * lerp(0.75, 1.05, rand(index, 1)) * lerp(0.85, 1, t)", arch: "=arch * lerp(0.55, 1.15, t)", unfurl: 1,
            leaflets: "=leaflets", leafletLength: "=leafletLength", leafletWidth: "=leafletWidth", leafletAngle: 62, leafletDroop: "=leafletDroop",
            shape: "lanceolate", stalk: 0.14, stemRadius: "=frondLength * 0.011", tintVariation: 0.4, seed: "=seed * 7 + index",
            stemRegion: "stem", leafRegion: "leaves",
            // Young fronds rise from the top; older ones lower down fan out wider.
            rotate: ["=-rise * (1 - t) - 4 + rand(index, 2) * 10", "=index * 137.5", "=-tilt"],
            at: ["=lean", "=height + topR * 0.4 - t * topR * 1.2", 0],
        },
        {
            id: "dead", type: "plant.frond", repeat: "=deadFronds",
            length: "=frondLength * 0.8", arch: 30, unfurl: 1, leaflets: "=round(leaflets * 0.6)", leafletLength: "=leafletLength * 0.8", leafletWidth: "=leafletWidth * 0.8",
            leafletAngle: 20, leafletDroop: 70, shape: "blade", stalk: 0.1, stemRadius: "=frondLength * 0.009", tintVariation: 0, seed: "=seed * 5 + index",
            stemRegion: "dead", leafRegion: "dead",
            rotate: ["=62 + rand(index, 3) * 16", "=index * 97 + 40", "=-tilt"],
            at: ["=lean", "=height - topR * 1.2", 0],
        },
        {
            id: "nuts", type: "mesh.sphere", repeat: "=coconuts", radius: "=nutSize * lerp(0.85, 1.1, rand(index, 5))", segments: 16, rings: 10, scale: [1, 1.12, 1],
            at: ["=lean + cos(index * 2.4) * (topR + nutSize * 0.8)", "=height - topR * 0.4 - nutSize * (0.4 + rand(index, 6) * 1.2)", "=sin(index * 2.4) * (topR + nutSize * 0.8)"],
            region: "nuts",
        },
    ],
    limits: { maxSize: 40, minSize: 1, maxTriangles: 200000 },
};

export default palm;
