import type { ObjectDef } from "../mesha_object";

/** A hollow ceramic mug turned in one profile (outside, over the rim, down the inside), with a swept handle. */
const mug: ObjectDef = {
    id: "household.mug",
    name: "Mug",
    category: "Household",
    tags: ["mug", "cup", "coffee cup", "tea cup", "ceramic", "kitchen", "tableware"],
    description: "Hollow stoneware mug or cup with a loop or ear handle.",
    featured: ["height", "radius", "taper", "handle", "glaze"],
    groups: [
        { id: "body", label: "Body" },
        { id: "handle", label: "Handle" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 0.095, min: 0.05, max: 0.16, unit: "m", decimals: 3, group: "body" },
        { id: "radius", label: "Radius", type: "number", default: 0.041, min: 0.025, max: 0.065, unit: "m", decimals: 3, group: "body" },
        { id: "taper", label: "Flare", type: "number", default: 0.06, min: -0.2, max: 0.35, group: "body", description: "Wider (positive) or narrower rim than base." },
        { id: "belly", label: "Belly", type: "number", default: 0, min: -0.08, max: 0.15, group: "body" },
        { id: "wall", label: "Wall thickness", type: "number", default: 0.0045, min: 0.002, max: 0.01, unit: "m", decimals: 4, group: "body" },
        { id: "foot", label: "Foot ring", type: "bool", default: true, group: "body" },
        { id: "handle", label: "Handle", type: "enum", default: "loop", options: ["loop", "ear", "none"], optionLabels: ["Loop", "Ear", "None"], group: "handle" },
        { id: "handleSize", label: "Handle size", type: "number", default: 1, min: 0.7, max: 1.4, group: "handle", visibleIf: "=handle != 'none'" },
        { id: "glaze", label: "Glaze", type: "material", default: "ceramic.speckled", materials: ["ceramic", "paint", "stone.slate"], group: "materials" },
        { id: "inside", label: "Inside", type: "material", default: "ceramic.white", materials: ["ceramic", "paint"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 8, group: "materials", variation: 0 },
    ],
    derived: {
        r0: "=radius",
        r1: "=radius * (1 + taper)",
        rm: "=radius * (1 + taper / 2 + belly)",
        tw: "=wall",
        floorT: "=max(wall * 1.6, 0.006)",
        hs: "=handleSize",
        // The body's curve runs from y0 to the rim; bez(r0, rm, r1, s) is its radius at fraction s.
        y0: "=height * 0.07",
        // Where the handle meets the wall.
        attachTop: "=height * 0.8",
        attachLow: "=handle == 'ear' ? height * 0.45 : height * 0.25",
        rTop: "=bez(r0, rm, r1, (attachTop - y0) / (height - y0))",
        rLow: "=bez(r0, rm, r1, (attachLow - y0) / (height - y0))",
        hx: "=(rTop + rLow) / 2",
        hy: "=(attachTop + attachLow) / 2",
        hh: "=(attachTop - attachLow) / 2",
        hr: "=(handle == 'ear' ? 0.017 : 0.03) * hs",
        // A tube thicker than its bend folds over itself: the handle thins to fit a small cup.
        tube: "=min(0.0068 * hs, hh * 0.55, hr * 0.55)",
    },
    rules: [
        { check: "=height > radius * 1.2 || handle != 'loop'", message: "Too squat for a loop handle; try an ear handle." },
        { check: "=wall * 4 < radius", message: "The walls are thicker than a mug's." },
    ],
    regions: {
        glaze: { label: "Glaze", material: "=glaze" },
        inside: { label: "Inside", material: "=inside" },
    },
    presets: [
        { name: "Diner mug", values: { height: 0.1, radius: 0.042, taper: 0, belly: 0.04, wall: 0.006, glaze: "ceramic.white", inside: "ceramic.white" } },
        { name: "Espresso cup", values: { height: 0.058, radius: 0.031, taper: 0.18, belly: 0.02, handle: "ear", handleSize: 0.8, glaze: "paint.navy" } },
        { name: "Tall latte", values: { height: 0.14, radius: 0.04, taper: 0.12, glaze: "paint.sage" } },
        { name: "Rustic tumbler", values: { height: 0.1, radius: 0.038, taper: -0.08, belly: 0.1, handle: "none", glaze: "stone.slate", inside: "ceramic.speckled", foot: false } },
    ],
    nodes: [
        {
            id: "shellProfile", type: "curve.points", output: false, fillet: 0.0012, filletSegments: 4,
            // Up the outside (a smooth quadratic through the belly), round over the rim, down the
            // inside the same way, across the floor to the axis.
            points: [
                [0, "=foot ? 0.003 : 0"], ["=r0 * (foot ? 0.78 : 0.9)", "=foot ? 0.003 : 0"], ["=r0 * (foot ? 0.84 : 0.97)", 0], ["=r0", "=y0"],
                ["=bez(r0, rm, r1, 0.2)", "=lerp(y0, height, 0.2)"], ["=bez(r0, rm, r1, 0.4)", "=lerp(y0, height, 0.4)"],
                ["=bez(r0, rm, r1, 0.6)", "=lerp(y0, height, 0.6)"], ["=bez(r0, rm, r1, 0.8)", "=lerp(y0, height, 0.8)"],
                ["=r1", "=height - tw * 0.6"], ["=r1 - tw * 0.5", "=height"], ["=r1 - tw", "=height - tw * 0.6"],
                ["=bez(r0, rm, r1, 0.8) - tw", "=lerp(y0, height, 0.8)"], ["=bez(r0, rm, r1, 0.6) - tw", "=lerp(y0, height, 0.6)"],
                ["=bez(r0, rm, r1, 0.4) - tw", "=lerp(y0, height, 0.4)"], ["=bez(r0, rm, r1, 0.2) - tw", "=lerp(y0, height, 0.2)"],
                ["=r0 - tw", "=floorT + 0.004"], ["=(r0 - tw) * 0.8", "=floorT"], [0, "=floorT"],
            ],
        },
        { id: "body", type: "mesh.lathe", profile: "@shellProfile", segments: 64, smoothAngle: 55, region: "glaze" },
        // The inside glaze: a thin skin just inside the wall, from the floor to the lip.
        {
            id: "innerProfile", type: "curve.points", output: false,
            points: [
                [0, "=floorT + 0.0003"], ["=(r0 - tw) * 0.8 - 0.0003", "=floorT + 0.0003"], ["=r0 - tw - 0.0003", "=floorT + 0.004"],
                ["=bez(r0, rm, r1, 0.2) - tw - 0.0003", "=lerp(y0, height, 0.2)"], ["=bez(r0, rm, r1, 0.4) - tw - 0.0003", "=lerp(y0, height, 0.4)"],
                ["=bez(r0, rm, r1, 0.6) - tw - 0.0003", "=lerp(y0, height, 0.6)"], ["=bez(r0, rm, r1, 0.8) - tw - 0.0003", "=lerp(y0, height, 0.8)"],
                ["=r1 - tw - 0.0003", "=height - tw * 0.7"],
            ],
        },
        { id: "insideGlaze", type: "mesh.lathe", profile: "@innerProfile", segments: 64, smoothAngle: 55, region: "inside" },
        // The handle: half an ellipse out from the wall between its two attachment points
        // (a tall D for a loop, a small round ear), ends tucked just inside the wall.
        {
            id: "handlePath", type: "path.points", output: false, smooth: 6,
            points: [
                ["=rTop - 0.003", "=attachTop", 0],
                ["=hx + hr * cos(rad(60))", "=hy + hh * sin(rad(60))", 0], ["=hx + hr * cos(rad(25))", "=hy + hh * sin(rad(25))", 0],
                ["=hx + hr", "=hy", 0],
                ["=hx + hr * cos(rad(25))", "=hy - hh * sin(rad(25))", 0], ["=hx + hr * cos(rad(60))", "=hy - hh * sin(rad(60))", 0],
                ["=rLow - 0.003", "=attachLow", 0],
            ],
        },
        { id: "handleProfile", type: "curve.ellipse", output: false, rx: "=tube * 0.7", ry: "=tube", segments: 20 },
        { id: "handleMesh", type: "mesh.sweep", when: "=handle != 'none'", path: "@handlePath", profile: "@handleProfile", region: "glaze" },
    ],
    limits: { maxSize: 0.3, minSize: 0.04, maxTriangles: 30000 },
};

export default mug;
