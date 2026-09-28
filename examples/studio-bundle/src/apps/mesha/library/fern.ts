import type { ObjectDef, NodeDef } from "../mesha_object";

/** A fern: a rosette of arching pinnate fronds, from a flat spreading crown to an upright vase, with unfurling fiddleheads. */

const fern: ObjectDef = {
    id: "nature.fern",
    name: "Fern",
    category: "Nature",
    tags: ["fern", "ferns", "bracken", "frond", "fronds", "undergrowth", "woodland", "forest", "foliage", "plant", "nature", "landscape", "ground cover"],
    description: "A rosette of arching pinnate fronds, with fiddleheads.",
    featured: ["frondLength", "fronds", "upright", "arch", "pairs", "leafFinish", "seed"],
    groups: [
        { id: "form", label: "Form" },
        { id: "fronds", label: "Fronds" },
        { id: "leaflets", label: "Leaflets" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "frondLength", label: "Frond length", type: "number", default: 0.9, min: 0.15, max: 3, unit: "m", group: "form" },
        { id: "fronds", label: "Fronds", type: "int", default: 14, min: 4, max: 32, group: "form" },
        { id: "upright", label: "Upright", type: "number", default: 0.55, min: 0, max: 1, group: "form", description: "0 lies flat like a rosette; 1 is a tall vase." },
        { id: "arch", label: "Arch", type: "number", default: 75, min: 10, max: 160, unit: "°", group: "form", description: "How far each frond bends over toward its tip." },
        { id: "sizeVariety", label: "Size variety", type: "number", default: 0.3, min: 0, max: 0.7, group: "form" },
        { id: "irregularity", label: "Irregularity", type: "number", default: 0.3, min: 0, max: 1, group: "form" },
        { id: "fiddleheads", label: "Fiddleheads", type: "int", default: 3, min: 0, max: 8, group: "fronds" },
        { id: "stalk", label: "Bare stalk", type: "number", default: 0.14, min: 0, max: 0.5, group: "fronds", description: "Share of each frond that is bare stalk." },
        { id: "rachis", label: "Stalk thickness", type: "number", default: 0.008, min: 0.002, max: 0.03, unit: "m", group: "fronds" },
        { id: "pairs", label: "Leaflet pairs", type: "int", default: 22, min: 6, max: "=min(40, max(6, floor((50000 / fronds - 100) / 16)))", group: "leaflets" },
        { id: "leafletLength", label: "Leaflet length", type: "number", default: 0.3, min: 0.1, max: 0.6, group: "leaflets", description: "Longest leaflet as a share of the frond." },
        { id: "leafletWidth", label: "Leaflet width", type: "number", default: 0.3, min: 0.06, max: 0.7, group: "leaflets" },
        { id: "leafletAngle", label: "Leaflet sweep", type: "number", default: 68, min: 30, max: 90, unit: "°", group: "leaflets" },
        { id: "leafletFold", label: "Leaflet fold", type: "number", default: 30, min: 0, max: 70, unit: "°", group: "leaflets" },
        { id: "leafletDroop", label: "Leaflet droop", type: "number", default: 22, min: 0, max: 90, unit: "°", group: "leaflets" },
        { id: "peak", label: "Widest at", type: "number", default: 0.38, min: 0.15, max: 0.8, group: "leaflets", description: "Where along the frond the leaflets are longest." },
        { id: "leafFinish", label: "Fronds", type: "material", default: "leaf.fresh", materials: ["leaf"], group: "materials" },
        { id: "stalkFinish", label: "Young fronds", type: "material", default: "leaf.spring", materials: ["leaf"], group: "materials", visibleIf: "=fiddleheads > 0" },
        { id: "seed", label: "Seed", type: "seed", default: 8, group: "materials", variation: 0 },
    ],
    regions: {
        fronds: { label: "Fronds", material: "=leafFinish" },
        young: { label: "Fiddleheads", material: "=stalkFinish" },
    },
    presets: [
        { name: "Woodland fern", values: {} },
        { name: "Bracken", values: { frondLength: 1.5, fronds: 9, upright: 0.7, arch: 55, pairs: 18, leafletLength: 0.4, leafletWidth: 0.4, leafletAngle: 80, leafFinish: "leaf.olive", stalkFinish: "leaf.fresh", fiddleheads: 2 } },
        { name: "Sword fern", values: { frondLength: 1.1, fronds: 20, upright: 0.8, arch: 50, pairs: 30, leafletLength: 0.2, leafletWidth: 0.2, leafletAngle: 60, leafFinish: "leaf.deep", peak: 0.3 } },
        { name: "Boston fern", values: { frondLength: 0.8, fronds: 24, upright: 0.25, arch: 110, pairs: 32, leafletLength: 0.22, leafletWidth: 0.22, leafletDroop: 40, leafFinish: "leaf.spring", fiddleheads: 0 } },
        { name: "Lady fern", values: { frondLength: 0.7, fronds: 12, upright: 0.5, arch: 90, pairs: 20, leafletLength: 0.34, leafletWidth: 0.42, leafFinish: "leaf.sage", stalkFinish: "leaf.spring" } },
        { name: "Tree fern crown", values: { frondLength: 2.4, fronds: 18, upright: 0.6, arch: 80, pairs: 34, leafletLength: 0.25, leafletWidth: 0.2, leafFinish: "leaf.forest", fiddleheads: 5, rachis: 0.02 } },
    ],
    nodes: [
        {
            id: "frondsNode", type: "mesh.frond", repeat: "=fronds",
            length: "=frondLength * (1 - sizeVariety * rand(index, 1)) * (0.55 + 0.45 * sin(PI * (0.1 + 0.9 * t)) * 0.9 + 0.1)",
            pairs: "=pairs", leafletLength: "=leafletLength", leafletWidth: "=leafletWidth", angle: "=leafletAngle", lift: 14, droop: "=leafletDroop", curl: "=min(arch * (0.75 + 0.5 * t), 30 + 2.2 * (lerp(20 + 60 * upright, 8 + 18 * upright, t)))",
            peak: "=peak", gap: "=stalk", rachis: "=rachis", fold: "=leafletFold",
            at: [0, "=frondLength * 0.14", 0],
            rotate: ["=-90 + lerp(20 + 60 * upright, 8 + 18 * upright, t) + (rand(index, 2) - 0.5) * irregularity * 26", "=index * 137.5 + (rand(index, 3) - 0.5) * irregularity * 40", 0],
            region: "fronds",
        },
        {
            id: "heads", type: "mesh.frond", repeat: "=fiddleheads", when: "=fiddleheads > 0",
            length: "=frondLength * 0.34", pairs: 9, leafletLength: 0.22, leafletWidth: 0.4, angle: 50, lift: 5, droop: 60, curl: 200, peak: 0.5, gap: 0.05, rachis: "=rachis * 0.7", fold: 50,
            at: [0, "=frondLength * 0.14", 0],
            rotate: ["=-90 + 80 - upright * 6 + (rand(index, 5) - 0.5) * 12", "=index * 137.5 + 60 + (rand(index, 6) - 0.5) * 30", 0],
            region: "young",
        },
    ] as NodeDef[],
    limits: { maxSize: 12, minSize: 0.05, maxTriangles: 80000, floorTolerance: 0.15 },
};

export default fern;
