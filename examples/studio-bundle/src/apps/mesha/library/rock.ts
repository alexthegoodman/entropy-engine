import type { ObjectDef } from "../mesha_object";

/** A rock, or a small cluster of them: noise-displaced, flattened where it rests on the ground. */
const rock: ObjectDef = {
    id: "nature.rock",
    name: "Rock",
    category: "Nature",
    tags: ["rock", "stone", "boulder", "pebble", "rocks", "cluster", "nature", "landscape"],
    description: "Boulder, pebble or cluster of rocks, rounded or faceted.",
    featured: ["size", "roughness", "flatness", "count", "faceted", "stone"],
    groups: [
        { id: "shape", label: "Shape" },
        { id: "cluster", label: "Cluster" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "size", label: "Size", type: "number", default: 0.6, min: 0.05, max: 3, unit: "m", group: "shape" },
        { id: "elongation", label: "Elongation", type: "number", default: 1.3, min: 1, max: 2.5, group: "shape" },
        { id: "flatness", label: "Flatness", type: "number", default: 0.7, min: 0.3, max: 1, group: "shape", description: "Height relative to width." },
        { id: "roughness", label: "Roughness", type: "number", default: 0.22, min: 0, max: 0.45, group: "shape" },
        { id: "detail", label: "Detail", type: "number", default: 2.2, min: 0.8, max: 5, group: "shape", description: "Noise frequency." },
        { id: "faceted", label: "Faceted", type: "bool", default: false, group: "shape" },
        { id: "buried", label: "Buried", type: "number", default: 0.18, min: 0, max: 0.45, group: "shape", description: "How much sinks below ground (cut flat)." },
        { id: "count", label: "Rocks", type: "int", default: 1, min: 1, max: 9, group: "cluster" },
        { id: "spread", label: "Spread", type: "number", default: 1.1, min: 0.5, max: 3, group: "cluster", visibleIf: "=count > 1" },
        { id: "stone", label: "Stone", type: "material", default: "stone.granite", materials: ["stone"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 21, group: "materials", variation: 0 },
    ],
    derived: { subdiv: "=faceted ? 2 : 4" },
    regions: { rock: { label: "Rock", material: "=stone" } },
    presets: [
        { name: "Boulder", values: { size: 1.4, elongation: 1.2, flatness: 0.75, roughness: 0.2, stone: "stone.granite" } },
        { name: "River stones", values: { size: 0.18, elongation: 1.5, flatness: 0.45, roughness: 0.06, detail: 1.2, count: 7, spread: 1.4, stone: "stone.slate", buried: 0.05 } },
        { name: "Low-poly outcrop", values: { size: 1, elongation: 1.6, flatness: 0.8, roughness: 0.3, faceted: true, count: 3, stone: "stone.sandstone" } },
    ],
    nodes: [
        {
            id: "rocks", type: "object", object: "component.rockPiece", repeat: "=count", region: "rock",
            params: {
                size: "=size * (index == 0 ? 1 : lerp(0.35, 0.8, rand(index, 1)))",
                elongation: "=elongation", flatness: "=flatness", roughness: "=roughness", detail: "=detail", faceted: "=faceted", buried: "=buried",
                seed: "=seed * 13 + index * 7",
            },
            // A golden-angle spiral keeps the smaller rocks around the first without piling onto it.
            at: ["=cos(index * 2.39996 + rand(index, 2) * 0.6) * size * spread * (0.35 + 0.42 * sqrt(index))", 0, "=sin(index * 2.39996 + rand(index, 2) * 0.6) * size * spread * (0.35 + 0.42 * sqrt(index))"],
            rotate: [0, "=rand(index, 4) * 360", 0],
        },
    ],
    limits: { maxSize: 25, minSize: 0.02, maxTriangles: 60000 },
};

/** One rock of a cluster. */
export const rockPiece: ObjectDef = {
    id: "component.rockPiece",
    name: "Rock piece",
    category: "Components",
    component: true,
    groups: [{ id: "shape", label: "Shape" }],
    params: [
        { id: "size", label: "Size", type: "number", default: 0.6, min: 0.01, max: 4, group: "shape" },
        { id: "elongation", label: "Elongation", type: "number", default: 1.3, min: 1, max: 3, group: "shape" },
        { id: "flatness", label: "Flatness", type: "number", default: 0.7, min: 0.2, max: 1, group: "shape" },
        { id: "roughness", label: "Roughness", type: "number", default: 0.2, min: 0, max: 0.5, group: "shape" },
        { id: "detail", label: "Detail", type: "number", default: 2, min: 0.5, max: 6, group: "shape" },
        { id: "faceted", label: "Faceted", type: "bool", default: false, group: "shape" },
        { id: "buried", label: "Buried", type: "number", default: 0.15, min: 0, max: 0.5, group: "shape" },
        { id: "seed", label: "Seed", type: "seed", default: 1, max: 999999, group: "shape" },
    ],
    derived: { half: "=size / 2" },
    regions: { rock: { label: "Rock", material: "stone.granite" } },
    nodes: [
        { id: "ball", type: "mesh.icosphere", output: false, radius: 1, subdivisions: "=faceted ? 2 : 4" },
        { id: "bumpy", type: "deform.noise", output: false, mesh: "@ball", amount: "=roughness * 1.6 * min(1, 1.6 / (detail * 0.6))", frequency: "=detail * 0.6", octaves: "=faceted ? 2 : 5", seed: "=seed", faceted: false, radial: true },
        { id: "shaped", type: "geo.transform", output: false, mesh: "@bumpy", scale: ["=half * elongation * lerp(0.85, 1.15, rand(1))", "=half * flatness", "=half * lerp(0.8, 1.1, rand(2))"] },
        // Squash (rather than cut) what sinks below ground: a monotonic squash can't fold faces over.
        { id: "sunk", type: "deform.clamp", output: false, mesh: "@shaped", min: "=-half * flatness * (1 - buried * 2)", give: 0.06 },
        { id: "rock", type: "geo.smooth", mesh: "@sunk", smooth: "=!faceted", angle: 75, rest: true, region: "rock" },
    ],
};

export default rock;
