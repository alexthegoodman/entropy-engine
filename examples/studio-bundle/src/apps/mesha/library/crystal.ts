import type { ObjectDef } from "../mesha_object";

// A cluster of crystals growing out of a rocky base: faceted prisms with pointed tips, leaning out
// from the center at random, the biggest in the middle. They can glow (the deep's crystals hold
// the river's light) or be plain quartz. Standing on the ground at the origin.

export const crystalClusterDef: ObjectDef = {
    id: "nature.crystal_cluster",
    name: "Crystal Cluster",
    category: "Nature",
    tags: ["crystal", "crystals", "gem", "quartz", "mineral", "geode", "cave", "underground", "glow", "magic", "fantasy", "shard", "abyss"],
    description: "Faceted crystals growing from a rocky base, leaning outward, glowing with light or clear as quartz.",
    featured: ["count", "height", "spread", "crystalFinish"],
    groups: [{ id: "shape", label: "Shape" }, { id: "materials", label: "Materials" }],
    params: [
        { id: "count", label: "Crystals", type: "int", default: 7, min: 1, max: 16, group: "shape" },
        { id: "height", label: "Tallest", type: "number", default: 1.2, min: 0.1, max: 4, unit: "m", group: "shape" },
        { id: "thickness", label: "Thickness", type: "number", default: 0.18, min: 0.08, max: 0.35, group: "shape", description: "Prism radius relative to its height." },
        { id: "spread", label: "Spread", type: "number", default: 35, min: 0, max: 70, unit: "deg", group: "shape", description: "How far the outer crystals lean." },
        { id: "sides", label: "Facets", type: "int", default: 6, min: 4, max: 8, group: "shape" },
        { id: "base", label: "Rock base", type: "bool", default: true, group: "shape" },
        { id: "crystalFinish", label: "Crystal", type: "material", default: "glow.river", materials: ["glow", "glass.clear", "glass.violet", "glass.green", "glass.amber"], group: "materials" },
        { id: "rockFinish", label: "Base", type: "material", default: "stone.dark", materials: ["stone", "ground"], group: "materials", visibleIf: "=base" },
        { id: "seed", label: "Seed", type: "seed", default: 9, group: "materials", variation: 0 },
    ],
    derived: { H: "=height", rr: "=height * thickness" },
    regions: {
        crystal: { label: "Crystal", material: "=crystalFinish" },
        rock: { label: "Base", material: "=rockFinish" },
    },
    presets: [
        { name: "River crystals", values: {} },
        { name: "Violet spire", values: { count: 3, height: 3.2, spread: 18, crystalFinish: "glow.riverViolet" } },
        { name: "Quartz geode", values: { count: 12, height: 0.45, spread: 60, crystalFinish: "glass.clear", rockFinish: "stone.granite" } },
        { name: "Lumen shard", values: { count: 1, height: 0.25, base: false, spread: 0 } },
        { name: "Golden bloom", values: { count: 9, height: 0.9, crystalFinish: "glow.riverGold", spread: 50 } },
    ],
    nodes: [
        { id: "prism", type: "mesh.lathe", output: false, segments: "=sides", smoothAngle: 5, profile: [[0, 0], [1, 0], [1, 0.72], [0, 1]] },
        {
            id: "crystals", type: "geo.transform", repeat: "=count", mesh: "@prism",
            scale: ["=rr * (index == 0 ? 1 : 0.55 + rand(index, 1) * 0.4)", "=H * (index == 0 ? 1 : 0.35 + rand(index, 2) * 0.5)", "=rr * (index == 0 ? 1 : 0.55 + rand(index, 1) * 0.4)"],
            rotate: ["=index == 0 ? (rand(0, 3) - 0.5) * 8 : cos(rad(index * 137.5)) * spread * (0.5 + rand(index, 4) * 0.5)", "=rand(index, 5) * 360", "=index == 0 ? (rand(0, 6) - 0.5) * 8 : sin(rad(index * 137.5)) * spread * (0.5 + rand(index, 4) * 0.5)"],
            at: ["=index == 0 ? 0 : cos(rad(index * 137.5)) * rr * 1.2", "=-rr * 0.2", "=index == 0 ? 0 : sin(rad(index * 137.5)) * rr * 1.2"],
            region: "crystal",
        },
        { id: "rockBase", type: "object", object: "component.rockPiece", when: "=base", params: { size: "=rr * 3.2", faceted: true, flatness: 0.4 }, at: [0, "=-rr * 0.35", 0], region: "rock" },
    ],
    limits: { maxSize: 8, minSize: 0.05, maxTriangles: 6000 },
};

export default crystalClusterDef;
