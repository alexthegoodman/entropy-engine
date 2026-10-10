import type { ObjectDef } from "../mesha_object";

// The inside of a plate or bowl is part of an ellipse, from the flat well at its bottom (angle -90°)
// up to where the rim begins (`thetaM`); the outside is the same curve pushed out along its normal
// by the wall thickness, so a steep bowl wall is as thick as a shallow plate's. Sampled here so the
// lathe profile below stays plain data.
const ANGLES = [0, 1, 2, 3, 4, 5, 6].map(k => k / 6);
const theta = (s: number) => `rad(-90 + (thetaM + 90) * ${s})`;
const inner = (s: number): [string, string] => [`=rw + ea * cos(${theta(s)})`, `=yc + eb * sin(${theta(s)})`];
const normalLen = (s: number) => `hypot(cos(${theta(s)}) / ea, sin(${theta(s)}) / eb)`;
const outer = (s: number): [string, string] => [
    `=rw + ea * cos(${theta(s)}) + wall * cos(${theta(s)}) / ea / ${normalLen(s)}`,
    `=yc + eb * sin(${theta(s)}) + wall * sin(${theta(s)}) / eb / ${normalLen(s)}`,
];

/**
 * Turned tableware and trays: plates, bowls, saucers and platters lathed from one closed profile
 * (foot ring, wall, rolled lip, rim, well) with an optional coloured rim band; and flat-bottomed
 * trays whose flared walls rise from a rounded rectangle, with pierced ear handles or bar handles.
 */
const dish: ObjectDef = {
    id: "household.dish",
    name: "Plate, Bowl & Tray",
    category: "Household",
    tags: ["plate", "dinner plate", "bowl", "cereal bowl", "pasta bowl", "saucer", "platter", "tray", "serving tray", "dish", "tableware", "crockery", "kitchen"],
    description: "Plates, bowls, saucers and platters with real wall thickness, and serving trays.",
    featured: ["shape", "diameter", "height", "rimWidth", "steepness", "glaze", "band"],
    groups: [
        { id: "form", label: "Form" },
        { id: "tray", label: "Tray" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "shape", label: "Shape", type: "enum", default: "plate", options: ["plate", "bowl", "tray"], optionLabels: ["Plate", "Bowl", "Tray"], group: "form" },
        { id: "diameter", label: "Diameter", type: "number", default: 0.27, min: 0.08, max: 0.5, unit: "m", decimals: 3, group: "form", visibleIf: "=shape != 'tray'" },
        { id: "height", label: "Height", type: "number", default: 0.025, min: "=shape == 'bowl' ? diameter * 0.14 : 0.008", max: "=shape == 'tray' ? 0.08 : shape == 'plate' ? diameter * 0.16 : min(0.2, diameter * 0.6)", unit: "m", decimals: 3, group: "form" },
        { id: "rimWidth", label: "Rim width", type: "number", default: 0.035, min: 0, max: "=diameter * 0.2", unit: "m", decimals: 3, group: "form", visibleIf: "=shape != 'tray'" },
        { id: "well", label: "Flat well", type: "number", default: 0.72, min: 0.1, max: 0.9, group: "form", visibleIf: "=shape != 'tray'", description: "How much of the inside is flat floor." },
        { id: "steepness", label: "Wall steepness", type: "number", default: 0.25, min: "=shape == 'bowl' ? 0.35 : 0", max: "=shape == 'plate' ? 0.6 : 1", group: "form", visibleIf: "=shape != 'tray'", description: "From a plate's gentle slope to a bowl's upright wall." },
        { id: "wall", label: "Wall thickness", type: "number", default: 0.0045, min: 0.002, max: 0.012, unit: "m", decimals: 4, group: "form" },
        { id: "foot", label: "Foot ring", type: "bool", default: true, group: "form", visibleIf: "=shape != 'tray'" },
        { id: "oval", label: "Oval", type: "number", default: 1, min: 0.55, max: 1, group: "form", visibleIf: "=shape != 'tray'", description: "Below 1 stretches a plate into a platter." },
        { id: "trayWidth", label: "Width", type: "number", default: 0.45, min: 0.15, max: 0.8, unit: "m", group: "tray", visibleIf: "=shape == 'tray'" },
        { id: "trayDepth", label: "Depth", type: "number", default: 0.32, min: 0.1, max: 0.6, unit: "m", group: "tray", visibleIf: "=shape == 'tray'" },
        { id: "corner", label: "Corner radius", type: "number", default: 0.03, min: 0.004, max: "=min(trayWidth, trayDepth) * 0.45", unit: "m", decimals: 3, group: "tray", visibleIf: "=shape == 'tray'" },
        { id: "flare", label: "Wall flare", type: "number", default: 12, min: 0, max: 40, unit: "°", group: "tray", visibleIf: "=shape == 'tray'" },
        { id: "handles", label: "Handles", type: "enum", default: "ears", options: ["none", "ears", "bars"], optionLabels: ["None", "Pierced ears", "Bar handles"], group: "tray", visibleIf: "=shape == 'tray'" },
        { id: "glaze", label: "Body", type: "material", default: "ceramic.white", materials: ["ceramic", "stone.slate", "stone.marble", "wood", "metal.steel", "metal.brass", "metal.copper", "paint", "glass.clear", "glass.green", "plastic"], group: "materials" },
        { id: "band", label: "Rim band", type: "bool", default: false, group: "materials", visibleIf: "=shape != 'tray' && rimWidth > 0.01" },
        { id: "bandFinish", label: "Band", type: "material", default: "paint.navy", materials: ["paint", "metal.gold", "metal.brass", "ceramic.speckled"], group: "materials", visibleIf: "=band && shape != 'tray'" },
        { id: "seed", label: "Seed", type: "seed", default: 4, group: "materials", variation: 0 },
    ],
    derived: {
        R: "=diameter / 2",
        footH: "=foot ? clamp(height * 0.12, 0.002, 0.006) : 0",
        yf: "=footH + wall",
        // Where the rim begins, and the flat well's radius.
        rimR: "=max(R - max(rimWidth, wall * 1.5), R * 0.3)",
        rw: "=max(rimR * well * (1 - steepness * 0.5), 0.004)",
        rimRise: "=min(rimWidth * 0.12, height * 0.25)",
        thetaM: "=-62 + steepness * 60",
        ea: "=max((rimR - rw) / cos(rad(thetaM)), 0.003)",
        eb: "=max((height - rimRise - wall * 0.5 - yf) / (1 + sin(rad(thetaM))), 0.002)",
        yc: "=yf + eb",
        // Where the inner and outer curves end, at the rim.
        xe: "=rw + ea * cos(rad(thetaM))",
        ye: "=yc + eb * sin(rad(thetaM))",
        footR: "=max(rw * 0.85, R * 0.25)",
        isTray: "=shape == 'tray'",
        tw: "=trayWidth",
        td: "=trayDepth",
        flareK: "=1 + 2 * height * tan(rad(flare)) / min(tw, td)",
    },
    rules: [
        { check: "=isTray || height > wall * 2.5 + footH", message: "Too shallow for its wall thickness." },
        { check: "=isTray || rw < rimR - wall", message: "The well swallows the wall: lower Flat well." },
        { check: "=!isTray || corner < min(tw, td) * 0.45", message: "The corners are rounder than the tray." },
    ],
    regions: {
        body: { label: "Body", material: "=glaze" },
        band: { label: "Rim band", material: "=bandFinish" },
        handles: { label: "Handles", material: "=glaze" },
    },
    presets: [
        { name: "Dinner plate", values: { shape: "plate", diameter: 0.27, height: 0.024, rimWidth: 0.038, well: 0.75, steepness: 0.15, wall: 0.0045, foot: true, glaze: "ceramic.white", band: true, bandFinish: "paint.navy" } },
        { name: "Side plate", values: { shape: "plate", diameter: 0.19, height: 0.018, rimWidth: 0.025, well: 0.7, steepness: 0.2, glaze: "ceramic.speckled" } },
        { name: "Cereal bowl", values: { shape: "bowl", diameter: 0.16, height: 0.065, rimWidth: 0, well: 0.35, steepness: 0.85, wall: 0.005, foot: true, glaze: "ceramic.speckled" } },
        { name: "Pasta bowl", values: { shape: "bowl", diameter: 0.25, height: 0.05, rimWidth: 0.04, well: 0.45, steepness: 0.55, wall: 0.005, glaze: "ceramic.white", band: true, bandFinish: "metal.gold" } },
        { name: "Saucer", values: { shape: "plate", diameter: 0.15, height: 0.02, rimWidth: 0.02, well: 0.4, steepness: 0.3, wall: 0.0035, glaze: "ceramic.white" } },
        { name: "Oval platter", values: { shape: "plate", diameter: 0.42, height: 0.03, rimWidth: 0.05, well: 0.8, steepness: 0.2, wall: 0.006, oval: 0.68, glaze: "ceramic.terracotta" } },
        { name: "Serving tray", values: { shape: "tray", trayWidth: 0.5, trayDepth: 0.34, height: 0.035, corner: 0.03, flare: 10, wall: 0.008, handles: "ears", glaze: "wood.walnut" } },
        { name: "Steel tray", values: { shape: "tray", trayWidth: 0.4, trayDepth: 0.3, height: 0.025, corner: 0.012, flare: 25, wall: 0.002, handles: "bars", glaze: "metal.steel" } },
    ],
    nodes: [
        // ===== Plate or bowl: one closed profile from the axis under the foot round to the axis on the floor.
        {
            id: "profile", type: "curve.points", output: false, smooth: 0,
            points: [
                [0, "=footH"],
                ["=foot ? footR - 0.004 : rw * 0.9", "=footH"],
                ["=foot ? footR - 0.002 : rw * 0.95", 0],
                ["=foot ? footR + 0.002 : rw", 0],
                ["=foot ? footR + 0.004 : rw", "=footH"],
                ...ANGLES.slice(1).map(outer),
                ["=R - wall * 0.2", "=height - wall * 0.9"],
                ["=R", "=height - wall * 0.45"],
                ["=R - wall * 0.35", "=height"],
                ["=xe + (R - xe) * 0.5", "=ye + rimRise * 0.6"],
                ...ANGLES.slice().reverse().map(inner),
                [0, "=yf"],
            ],
        },
        { id: "vessel", type: "mesh.lathe", when: "=!isTray", profile: "@profile", segments: 72, smoothAngle: 55, scale: [1, 1, "=oval"], region: "body" },
        // A coloured band laid on the rim.
        {
            id: "bandProfile", type: "curve.points", output: false,
            points: [["=xe + (R - xe) * 0.25", "=ye + rimRise * 0.3 + 0.0003"], ["=xe + (R - xe) * 0.5", "=ye + rimRise * 0.6 + 0.0003"], ["=R - wall * 0.6", "=height - wall * 0.05 + 0.0003"]],
        },
        { id: "rimBand", type: "mesh.lathe", when: "=!isTray && band && rimWidth > 0.01", profile: "@bandProfile", segments: 72, scale: [1, 1, "=oval"], region: "band" },
        // ===== Tray: a floor, a wall ring flaring out as it rises, and handles at the ends.
        { id: "trayOutline", type: "curve.rect", output: false, width: "=tw", height: "=td", radius: "=corner", cornerSegments: 8 },
        { id: "trayInner", type: "curve.rect", output: false, width: "=tw - 2 * wall", height: "=td - 2 * wall", radius: "=max(corner - wall, 0.001)", cornerSegments: 8 },
        { id: "trayFloor", type: "mesh.extrude", when: "=isTray", outline: "@trayOutline", height: "=wall * 1.2", bevel: "=wall * 0.3", region: "body" },
        { id: "trayWallStraight", type: "mesh.extrude", output: false, outline: "@trayOutline", holes: ["@trayInner"], height: "=height", bevel: "=wall * 0.35" },
        { id: "trayWall", type: "deform.taper", when: "=isTray", mesh: "@trayWallStraight", amount: "=flareK", y0: 0, y1: "=height", region: "body" },
        // Ears: a flat tab with a finger hole, flush with the wall's top at each end.
        { id: "earOutline", type: "curve.rect", output: false, width: 0.065, height: "=min(td * 0.5, 0.16)", radius: 0.028, cornerSegments: 8 },
        { id: "earHole", type: "curve.rect", output: false, width: 0.026, height: "=min(td * 0.5, 0.16) * 0.6", radius: 0.012, cornerSegments: 6 },
        { id: "earHoleAt", type: "curve.transform", output: false, curve: "@earHole", offset: [0.008, 0] },
        { id: "ear", type: "mesh.extrude", output: false, outline: "@earOutline", holes: ["@earHoleAt"], height: "=max(wall, 0.004)", bevel: "=max(wall, 0.004) * 0.3" },
        { id: "ears", type: "geo.transform", when: "=isTray && handles == 'ears'", repeat: 2, mesh: "@ear", rotate: [0, "=index * 180", 0], at: ["=(1 - index * 2) * (tw / 2 * flareK + 0.02)", "=height - max(wall, 0.004)", 0], region: "handles" },
        {
            id: "bars", type: "object", object: "component.handle", when: "=isTray && handles == 'bars'", repeat: 2, region: "handles",
            params: { style: "bow", length: "=min(td * 0.55, 0.16)", thickness: 0.008, projection: 0.03 },
            rotate: [0, "=90 + index * 180", 0], at: ["=(1 - index * 2) * (tw / 2 + height * tan(rad(flare)) * 0.6)", "=height * 0.65", 0],
        },
    ],
    limits: { maxSize: 0.95, minSize: 0.04, maxTriangles: 30000 },
};

export default dish;
