import type { ObjectDef } from "../mesha_object";

/**
 * A reusable furniture leg, built from y = 0 (floor) up to `height`. Tables, chairs and stools
 * compose it with `{ "type": "object", "object": "component.leg" }` so every piece of furniture
 * shares the same leg vocabulary.
 */
const leg: ObjectDef = {
    id: "component.leg",
    name: "Leg",
    category: "Components",
    component: true,
    tags: ["leg", "furniture part"],
    description: "Square, tapered, round, turned or hairpin leg.",
    groups: [{ id: "shape", label: "Shape" }],
    params: [
        { id: "height", label: "Height", type: "number", default: 0.72, min: 0.05, max: 1.4, unit: "m", group: "shape" },
        { id: "thickness", label: "Thickness", type: "number", default: 0.05, min: 0.012, max: 0.2, unit: "m", group: "shape" },
        { id: "style", label: "Style", type: "enum", default: "tapered", options: ["square", "tapered", "round", "turned", "hairpin"], optionLabels: ["Square", "Tapered", "Round", "Turned", "Hairpin"], group: "shape" },
        { id: "taper", label: "Foot size", type: "number", default: 0.6, min: 0.3, max: 1, group: "shape", visibleIf: "=style == 'tapered' || style == 'round'" },
        { id: "edge", label: "Edge rounding", type: "number", default: 0.25, min: 0, max: 0.5, group: "shape", visibleIf: "=style == 'square' || style == 'tapered'" },
        { id: "seed", label: "Seed", type: "seed", default: 1, group: "shape", variation: 0 },
    ],
    derived: {
        r: "=thickness / 2",
        rod: "=clamp(thickness * 0.16, 0.005, 0.014)",
        bend: "=max(rod * 1.6, r * 0.5)",
    },
    regions: { leg: { label: "Leg", material: "wood.oak" } },
    nodes: [
        {
            id: "square", type: "mesh.box", when: "=style == 'square' || style == 'tapered'",
            size: ["=thickness", "=height", "=thickness"], radius: "=thickness * edge * 0.5", segments: 3,
            at: [0, "=height / 2", 0], output: false,
        },
        { id: "boxLeg", type: "deform.taper", when: "=style == 'square' || style == 'tapered'", mesh: "@square", amount: "=style == 'tapered' ? taper : 1", y0: "=height", y1: 0, region: "leg" },
        {
            id: "round", type: "mesh.cone", when: "=style == 'round'",
            bottomRadius: "=r * taper", topRadius: "=r", height: "=height", segments: 32, bevel: "=r * 0.2", region: "leg",
        },
        // A turned leg: foot bead, long swelling shaft, collar ring and a cove up into the top block.
        {
            id: "turnedProfile", type: "curve.points", smooth: 6, output: false,
            points: [
                ["=r * 0.62", 0], ["=r * 0.72", "=height * 0.018"], ["=r * 0.6", "=height * 0.05"],
                ["=r * 0.66", "=height * 0.2"], ["=r * 0.78", "=height * 0.45"], ["=r * 0.64", "=height * 0.66"],
                ["=r * 0.58", "=height * 0.7"], ["=r * 0.9", "=height * 0.72"], ["=r * 0.58", "=height * 0.745"],
                ["=r * 0.62", "=height * 0.77"], ["=r * 0.96", "=height * 0.8"], ["=r", "=height * 0.83"], ["=r", "=height"],
            ],
        },
        { id: "turned", type: "mesh.lathe", when: "=style == 'turned'", profile: "@turnedProfile", cap: true, segments: 40, smoothAngle: 50, region: "leg" },
        // Hairpin: one steel rod, two straight runs into a tight semicircular bend at the floor, both
        // ends meeting a small mounting plate. (A fillet can't make the bend: in so narrow a V it
        // would start far up the legs and lift the bend off the floor.)
        {
            id: "pinPath", type: "path.points", output: false,
            points: [
                ["=-r * 1.6", "=height - 0.006", 0], ["=-bend", "=bend + rod", 0],
                ["=bend * cos(rad(210))", "=bend + rod + bend * sin(rad(210))", 0], ["=bend * cos(rad(240))", "=bend + rod + bend * sin(rad(240))", 0],
                [0, "=rod", 0],
                ["=bend * cos(rad(300))", "=bend + rod + bend * sin(rad(300))", 0], ["=bend * cos(rad(330))", "=bend + rod + bend * sin(rad(330))", 0],
                ["=bend", "=bend + rod", 0], ["=r * 1.6", "=height - 0.006", 0],
            ],
        },
        { id: "pin", type: "mesh.sweep", when: "=style == 'hairpin'", path: "@pinPath", radius: "=rod", sides: 12, region: "leg" },
        { id: "plate", type: "mesh.box", when: "=style == 'hairpin'", size: ["=r * 4.4", 0.006, "=r * 1.6"], radius: 0.002, at: [0, "=height - 0.003", 0], region: "leg" },
    ],
    limits: { maxSize: 1.6, maxTriangles: 20000 },
};

export default leg;
