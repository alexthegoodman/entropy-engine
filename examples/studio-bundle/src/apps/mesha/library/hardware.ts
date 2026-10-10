import type { ObjectDef } from "../mesha_object";

/**
 * A cabinet, drawer, door or gate pull, mounted on a face at z = 0 and standing out into +Z, its
 * long axis along X (rotate it 90° about Z for a vertical door pull). Cabinets, crates and
 * appliances compose it so every front in the library shares one handle vocabulary.
 */
export const handle: ObjectDef = {
    id: "component.handle",
    name: "Handle",
    category: "Components",
    component: true,
    tags: ["handle", "pull", "knob", "drawer pull", "cabinet hardware"],
    description: "Bar, bow, knob, cup, ring or edge-tab pull, mounted on a face at z = 0.",
    groups: [{ id: "shape", label: "Shape" }],
    params: [
        { id: "style", label: "Style", type: "enum", default: "bar", options: ["bar", "bow", "knob", "cup", "ring", "tab"], optionLabels: ["Bar", "Bow", "Knob", "Cup", "Ring", "Edge tab"], group: "shape" },
        { id: "length", label: "Length", type: "number", default: 0.128, min: 0.03, max: 0.6, unit: "m", decimals: 3, group: "shape", description: "Bar and bow length, a cup's width; knobs and rings use it as a diameter scale." },
        { id: "thickness", label: "Thickness", type: "number", default: 0.012, min: 0.005, max: 0.03, unit: "m", decimals: 3, group: "shape" },
        { id: "projection", label: "Projection", type: "number", default: 0.032, min: 0.012, max: 0.08, unit: "m", decimals: 3, group: "shape" },
        { id: "seed", label: "Seed", type: "seed", default: 1, group: "shape", variation: 0 },
    ],
    derived: {
        r: "=thickness / 2",
        // Knob and ring sizes come from the length so a parent can size every style with one value.
        knobR: "=clamp(length * 0.18, 0.009, 0.03)",
        ringR: "=clamp(length * 0.2, 0.012, 0.05)",
        // Posts sit in from the bar ends; the bar overhangs them a little.
        posts: "=length * 0.78",
        proj: "=max(projection, thickness * 1.6)",
        cupW: "=max(length, 0.05)",
        cupR: "=clamp(cupW * 0.28, 0.012, 0.035)",
    },
    regions: { handle: { label: "Handle", material: "metal.steel" } },
    nodes: [
        // Bar: a rod on two standoff posts with rounded ends.
        { id: "bar", type: "mesh.cylinder", when: "=style == 'bar'", radius: "=r", height: "=length", segments: 20, bevel: "=r * 0.6", rotate: [0, 0, -90], at: ["=-length / 2", 0, "=proj - r"], region: "handle" },
        { id: "posts", type: "mesh.cylinder", when: "=style == 'bar'", repeat: 2, radius: "=r * 0.72", height: "=proj - r", segments: 16, rotate: [90, 0, 0], at: ["=(index * 2 - 1) * posts / 2", 0, 0], region: "handle" },
        { id: "roses", type: "mesh.cylinder", when: "=style == 'bar'", repeat: 2, radius: "=r * 1.15", height: 0.003, segments: 16, bevel: 0.001, rotate: [90, 0, 0], at: ["=(index * 2 - 1) * posts / 2", 0, 0], region: "handle" },
        // Bow: one swept rod bending out from the face and back, a D-pull.
        {
            id: "bowPath", type: "path.points", output: false, fillet: "=min(proj * 0.55, length * 0.2)", filletSegments: 6,
            points: [["=-length / 2", 0, -0.002], ["=-length / 2", 0, "=proj - r"], ["=length / 2", 0, "=proj - r"], ["=length / 2", 0, -0.002]],
        },
        { id: "bow", type: "mesh.sweep", when: "=style == 'bow'", path: "@bowPath", radius: "=r", sides: 14, region: "handle" },
        // Knob: a turned mushroom on a short neck.
        {
            id: "knobProfile", type: "curve.points", output: false, smooth: 5,
            points: [["=knobR * 0.62", 0], ["=knobR * 0.5", "=proj * 0.18"], ["=knobR * 0.34", "=proj * 0.42"], ["=knobR * 0.62", "=proj * 0.62"], ["=knobR", "=proj * 0.8"], ["=knobR * 0.9", "=proj * 0.96"], ["=knobR * 0.5", "=proj"]],
        },
        { id: "knob", type: "mesh.lathe", when: "=style == 'knob'", profile: "@knobProfile", cap: true, segments: 28, smoothAngle: 60, rotate: [90, 0, 0], region: "handle" },
        // Cup: a back plate and a quarter-round hood opening downward for the fingers, closed at both ends.
        { id: "cupPlate", type: "mesh.box", when: "=style == 'cup'", size: ["=cupW + 0.02", "=cupR * 1.5", 0.003], radius: 0.0012, at: [0, "=cupR * 0.1", 0.0015], region: "handle" },
        { id: "cupArc", type: "curve.sector", output: false, inner: "=cupR - 0.0025", outer: "=cupR", start: 0, end: 90, radius: 0.0008, segments: 14 },
        { id: "cupEnd", type: "curve.sector", output: false, inner: 0.0005, outer: "=cupR", start: 0, end: 90, radius: 0.0005, segments: 14 },
        // The sector's (u, v) become (y, z) and its extrusion runs along -X.
        { id: "cupHood", type: "mesh.extrude", when: "=style == 'cup'", outline: "@cupArc", height: "=cupW", bevel: 0.0008, rotate: [0, 0, 90], at: ["=cupW / 2", "=-cupR * 0.2", 0.002], region: "handle" },
        { id: "cupEnds", type: "mesh.extrude", when: "=style == 'cup'", repeat: 2, outline: "@cupEnd", height: 0.0025, rotate: [0, 0, 90], at: ["=index == 0 ? -cupW / 2 + 0.0025 : cupW / 2", "=-cupR * 0.2", 0.002], region: "handle" },
        // Ring: a rose on the face and a ring hanging from it.
        { id: "ringRose", type: "mesh.cylinder", when: "=style == 'ring'", radius: "=ringR * 0.38", height: "=thickness * 1.2", segments: 20, bevel: "=thickness * 0.4", rotate: [90, 0, 0], region: "handle" },
        { id: "ring", type: "mesh.torus", when: "=style == 'ring'", major: "=ringR", minor: "=r * 0.8", segments: 32, sides: 10, rotate: [80, 0, 0], at: [0, "=-ringR * 0.92", "=thickness * 1.2 + r * 0.4"], region: "handle" },
        // Edge tab: a thin lip along the top edge of a drawer or door.
        { id: "tabProfile", type: "curve.points", output: false, closed: true, fillet: 0.001, points: [[0, 0], [0, 0.004], ["=proj * 0.55", 0.004], ["=proj * 0.55", "=-thickness * 1.4"], ["=proj * 0.55 - 0.003", "=-thickness * 1.4"], ["=proj * 0.55 - 0.003", 0], [0, 0]] },
        // The profile's (u, v) become (z, y) and its extrusion runs along +X.
        { id: "tab", type: "mesh.extrude", when: "=style == 'tab'", outline: "@tabProfile", height: "=length", rotate: [-90, -90, 0], at: ["=-length / 2", 0, 0], region: "handle" },
    ],
    limits: { maxSize: 0.7, minSize: 0.01, maxTriangles: 6000, floor: false },
};

/**
 * A hinge whose pin runs along Y through the origin: a butt hinge's two leaves (one along -X, the
 * other along +X swung `open` degrees about the pin), or a decorative strap hinge for gates and
 * chests. Doors, gates, chests and lids compose it.
 */
export const hinge: ObjectDef = {
    id: "component.hinge",
    name: "Hinge",
    category: "Components",
    component: true,
    tags: ["hinge", "butt hinge", "strap hinge", "door hardware"],
    description: "Butt or strap hinge, pin along Y; the second leaf swings open.",
    groups: [{ id: "shape", label: "Shape" }],
    params: [
        { id: "style", label: "Style", type: "enum", default: "butt", options: ["butt", "strap"], optionLabels: ["Butt", "Strap"], group: "shape" },
        { id: "height", label: "Height", type: "number", default: 0.075, min: 0.025, max: 0.2, unit: "m", decimals: 3, group: "shape" },
        { id: "leafWidth", label: "Leaf width", type: "number", default: 0.03, min: 0.01, max: 0.6, unit: "m", decimals: 3, group: "shape", description: "A strap hinge's long leaf." },
        { id: "knuckles", label: "Knuckles", type: "int", default: 5, min: 3, max: 9, group: "shape" },
        { id: "open", label: "Open", type: "number", default: 180, min: 0, max: 270, unit: "°", group: "shape" },
        { id: "seed", label: "Seed", type: "seed", default: 1, group: "shape", variation: 0 },
    ],
    derived: {
        pinR: "=clamp(height * 0.045, 0.002, 0.008)",
        leafT: "=pinR * 0.55",
        kh: "=height / knuckles",
        strapW: "=style == 'strap' ? height * 0.55 : height",
        strapLen: "=max(leafWidth, height * 2)",
        // A butt hinge's leaves stay about as wide as it is tall.
        bw: "=min(leafWidth, height * 0.9)",
    },
    regions: { hinge: { label: "Hinge", material: "metal.brass" } },
    nodes: [
        { id: "knuckleRow", type: "mesh.cylinder", repeat: "=knuckles", radius: "=pinR", height: "=kh - 0.0006", segments: 14, bevel: "=pinR * 0.15", at: [0, "=-height / 2 + index * kh + 0.0003", 0], region: "hinge" },
        { id: "pinCaps", type: "mesh.sphere", repeat: 2, radius: "=pinR * 0.85", segments: 12, rings: 6, scale: [1, 0.6, 1], at: [0, "=(index * 2 - 1) * (height / 2 + pinR * 0.15)", 0], region: "hinge" },
        // The fixed leaf: a plain plate for a butt hinge, a short plate for a strap hinge.
        { id: "leafA", type: "mesh.box", size: ["=style == 'strap' ? min(height * 0.5, bw) : bw", "=height * 0.96", "=leafT"], radius: "=leafT * 0.4", at: ["=-(style == 'strap' ? min(height * 0.5, bw) : bw) / 2 - pinR * 0.6", 0, 0], region: "hinge" },
        // The swinging leaf: a plate or a strap tapering to a rounded end.
        { id: "strapOutline", type: "curve.points", output: false, closed: true, fillet: "=strapW * 0.12", points: [[0, "=-strapW / 2"], ["=strapLen * 0.82", "=-strapW * 0.22"], ["=strapLen", 0], ["=strapLen * 0.82", "=strapW * 0.22"], [0, "=strapW / 2"]] },
        { id: "plateOutline", type: "curve.rect", output: false, width: "=bw", height: "=height * 0.96", radius: "=leafT * 0.4" },
        // Extruded up Y from an (x, z) outline: stood into the XY plane (thickness toward -Z, centred),
        // pushed off the pin, then swung about it: open 180 lies flat along +X, 90 points out along +Z.
        { id: "leafBShape", type: "mesh.extrude", output: false, outline: { if: "=style == 'strap'", then: "@strapOutline", else: "@plateOutline" }, height: "=leafT", bevel: "=leafT * 0.25", rotate: [-90, 0, 0], at: ["=style == 'strap' ? pinR * 0.6 : bw / 2 + pinR * 0.6", 0, "=leafT / 2"] },
        { id: "leafB", type: "geo.transform", mesh: "@leafBShape", rotate: [0, "=open - 180", 0], region: "hinge" },
        { id: "nails", type: "mesh.sphere", when: "=style == 'strap'", repeat: 3, radius: "=leafT * 1.1", segments: 8, rings: 4, scale: [1, 1, 0.6], at: ["=-cos(rad(open)) * strapLen * (0.3 + index * 0.25) - sin(rad(open)) * leafT * 0.5", 0, "=sin(rad(open)) * strapLen * (0.3 + index * 0.25) - cos(rad(open)) * leafT * 0.5"], region: "hinge" },
    ],
    limits: { maxSize: 0.8, minSize: 0.01, maxTriangles: 6000, floor: false },
};
