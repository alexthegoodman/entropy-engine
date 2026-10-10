import type { ObjectDef } from "../mesha_object";

/**
 * Street furniture on a pole: a street light (tapered or heritage pole, one to four straight,
 * swept or scrolled arms, cobra-head, lantern, globe or slim LED fittings, or a lantern on the
 * pole top), a bollard (dome, heritage or lit), or a sign post (rectangle, round, triangle or
 * octagon plates, a transit stop flag with a timetable case). Lamp glass can glow (self-lit in the
 * viewport); it does not light the scene. Stands on the origin; arms reach along +X.
 */
const streetlight: ObjectDef = {
    id: "street.streetlight",
    name: "Streetlight, Bollard & Sign",
    category: "Street",
    tags: ["streetlight", "street light", "lamp post", "lamppost", "street lamp", "bollard", "sign", "signpost", "road sign", "stop sign", "bus stop", "transit stop", "lantern", "street furniture"],
    description: "Lamp posts, bollards and sign posts, with lit lamps.",
    featured: ["kind", "height", "poleStyle", "arms", "armStyle", "fitting", "lit", "signShape", "poleFinish"],
    groups: [
        { id: "kind", label: "Kind" },
        { id: "pole", label: "Pole" },
        { id: "lamp", label: "Lamp" },
        { id: "sign", label: "Sign" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "kind", label: "Kind", type: "enum", default: "light", options: ["light", "bollard", "sign", "stop"], optionLabels: ["Street light", "Bollard", "Sign post", "Transit stop"], group: "kind" },
        { id: "height", label: "Height", type: "number", default: 5, min: "=kind == 'bollard' ? 0.5 : 2", max: "=kind == 'bollard' ? 1.3 : kind == 'light' ? 12 : 4", unit: "m", group: "pole" },
        { id: "poleStyle", label: "Pole", type: "enum", default: "heritage", options: ["tapered", "heritage", "square"], optionLabels: ["Tapered steel", "Heritage cast", "Square section"], group: "pole" },
        { id: "poleRadius", label: "Pole radius", type: "number", default: 0.07, min: 0.03, max: 0.16, unit: "m", decimals: 3, group: "pole" },
        { id: "arms", label: "Arms", type: "int", default: 1, min: 0, max: 4, group: "lamp", visibleIf: "=kind == 'light'", description: "None puts the lamp on the pole's top." },
        { id: "armStyle", label: "Arm", type: "enum", default: "scroll", options: ["straight", "swept", "scroll"], optionLabels: ["Straight", "Swept", "Scrolled bracket"], group: "lamp", visibleIf: "=kind == 'light' && arms > 0" },
        { id: "reach", label: "Reach", type: "number", default: 0.9, min: 0.3, max: 3, unit: "m", group: "lamp", visibleIf: "=kind == 'light' && arms > 0" },
        { id: "fitting", label: "Fitting", type: "enum", default: "lantern", options: ["cobra", "lantern", "globe", "slim"], optionLabels: ["Cobra head", "Lantern", "Globe", "Slim LED"], group: "lamp", visibleIf: "=kind == 'light'" },
        { id: "lit", label: "Lit", type: "bool", default: true, group: "lamp", visibleIf: "=kind == 'light' || (kind == 'bollard' && bollardStyle == 'lit')" },
        { id: "bollardStyle", label: "Bollard", type: "enum", default: "dome", options: ["dome", "heritage", "lit"], optionLabels: ["Steel dome", "Heritage cast", "Lit louvre"], group: "pole", visibleIf: "=kind == 'bollard'" },
        { id: "signShape", label: "Sign shape", type: "enum", default: "rectangle", options: ["rectangle", "circle", "triangle", "octagon"], optionLabels: ["Rectangle", "Circle", "Triangle", "Octagon"], group: "sign", visibleIf: "=kind == 'sign'" },
        { id: "signSize", label: "Sign size", type: "number", default: 0.6, min: 0.25, max: 1.4, unit: "m", group: "sign", visibleIf: "=kind == 'sign' || kind == 'stop'" },
        { id: "signs", label: "Signs", type: "int", default: 1, min: 1, max: 2, group: "sign", visibleIf: "=kind == 'sign'" },
        { id: "poleFinish", label: "Pole", type: "material", default: "paint.black", materials: ["paint", "metal"], group: "materials" },
        { id: "signFinish", label: "Sign", type: "material", default: "paint.navy", materials: ["paint"], group: "materials", visibleIf: "=kind == 'sign' || kind == 'stop'" },
        { id: "faceFinish", label: "Sign border", type: "material", default: "paint.white", materials: ["paint"], group: "materials", visibleIf: "=kind == 'sign' || kind == 'stop'" },
        { id: "lampFinish", label: "Light", type: "material", default: "glow.warmWhite", materials: ["glow.warmWhite", "glow.amber", "glow.white", "glow.candle"], group: "materials", visibleIf: "=lit" },
        { id: "seed", label: "Seed", type: "seed", default: 21, group: "materials", variation: 0 },
    ],
    derived: {
        isLight: "=kind == 'light'",
        isBollard: "=kind == 'bollard'",
        isSign: "=kind == 'sign' || kind == 'stop'",
        pr: "=isBollard ? max(poleRadius, 0.07) : poleRadius",
        // The pole stops below a lantern on its top; with arms it runs to the top.
        poleH: "=isLight && arms == 0 ? height - (fitting == 'globe' ? 0.5 : 0.75) : height",
        topR: "=poleStyle == 'tapered' ? pr * 0.55 : pr * 0.7",
        // An arm leaves the pole a little below its top and reaches out to the lamp.
        armY: "=height - (armStyle == 'swept' ? 0.6 : 0.15)",
        tipX: "=reach",
        tipY: "=armStyle == 'swept' ? height + 0.05 : armStyle == 'straight' ? height - 0.15 + reach * tan(rad(8)) : height - 0.05",
        armR: "=clamp(pr * 0.3, 0.018, 0.04)",
        lampG: "=lit ? 'lamp' : 'glass'",
        sz: "=signSize",
        signY: "=height - sz / 2 - 0.08",
    },
    rules: [
        { check: "=!isLight || arms == 0 || reach < height * 0.6", message: "The arm reaches too far for the pole." },
        { check: "=!isSign || height > sz * (signs + 0.6)", message: "The signs don't fit on the post." },
        { check: "=!isLight || pr > 0.04 || height < 6", message: "Too slender a pole for its height." },
    ],
    regions: {
        pole: { label: "Pole", material: "=poleFinish" },
        lamp: { label: "Light", material: "=lampFinish" },
        glass: { label: "Lamp glass", material: "glass.frosted" },
        sign: { label: "Sign", material: "=signFinish" },
        face: { label: "Sign border", material: "=faceFinish" },
        band: { label: "Reflective band", material: "paint.white" },
        case: { label: "Timetable", material: "paper.white" },
    },
    presets: [
        { name: "Heritage lamp post", values: { kind: "light", height: 4.2, poleStyle: "heritage", poleRadius: 0.08, arms: 0, fitting: "lantern", lit: true, poleFinish: "paint.black", lampFinish: "glow.warmWhite" } },
        { name: "Highway cobra head", values: { kind: "light", height: 9, poleStyle: "tapered", poleRadius: 0.1, arms: 1, armStyle: "swept", reach: 2.2, fitting: "cobra", lit: true, poleFinish: "metal.zinc", lampFinish: "glow.white" } },
        { name: "Twin-arm boulevard", values: { kind: "light", height: 6, poleStyle: "heritage", poleRadius: 0.09, arms: 2, armStyle: "scroll", reach: 0.8, fitting: "lantern", lit: true, poleFinish: "paint.brunswick" } },
        { name: "Park globe", values: { kind: "light", height: 3.6, poleStyle: "tapered", poleRadius: 0.06, arms: 0, fitting: "globe", lit: true, poleFinish: "paint.black", lampFinish: "glow.white" } },
        { name: "Modern LED", values: { kind: "light", height: 7, poleStyle: "square", poleRadius: 0.075, arms: 1, armStyle: "straight", reach: 1.4, fitting: "slim", lit: true, poleFinish: "metal.aluminum", lampFinish: "glow.white" } },
        { name: "Steel bollard", values: { kind: "bollard", height: 0.9, bollardStyle: "dome", poleRadius: 0.1, poleFinish: "metal.steel" } },
        { name: "Lit path bollard", values: { kind: "bollard", height: 0.8, bollardStyle: "lit", poleRadius: 0.09, lit: true, poleFinish: "paint.black" } },
        { name: "Stop sign", values: { kind: "sign", height: 2.6, poleStyle: "square", poleRadius: 0.035, signShape: "octagon", signSize: 0.75, signs: 1, signFinish: "paint.crimson", faceFinish: "paint.white", poleFinish: "metal.zinc" } },
        { name: "Bus stop", values: { kind: "stop", height: 3.0, poleStyle: "tapered", poleRadius: 0.045, signSize: 0.5, signFinish: "paint.crimson", faceFinish: "paint.white", poleFinish: "metal.aluminum" } },
    ],
    nodes: [
        // ===== Pole and base ======================================================================
        { id: "taperedPole", type: "mesh.cone", when: "=poleStyle == 'tapered' && !isBollard", bottomRadius: "=pr", topRadius: "=topR", height: "=poleH", segments: 24, region: "pole" },
        { id: "squarePole", type: "mesh.box", when: "=poleStyle == 'square' && !isBollard", size: ["=pr * 1.6", "=poleH", "=pr * 1.6"], radius: "=pr * 0.15", at: [0, "=poleH / 2", 0], region: "pole" },
        // A heritage pole: a stepped, flared base, a fluted-looking shaft with collars, a cap.
        {
            id: "heritageProfile", type: "curve.points", output: false,
            points: [
                [0, 0], ["=pr * 2.4", 0], ["=pr * 2.4", 0.08], ["=pr * 2.0", 0.14], ["=pr * 2.0", 0.42], ["=pr * 1.7", 0.48], ["=pr * 1.45", 0.6], ["=pr * 1.35", 0.95],
                ["=pr * 1.6", 1.0], ["=pr * 1.6", 1.05], ["=pr * 1.1", 1.12], ["=pr", "=poleH * 0.55"], ["=pr * 1.3", "=poleH * 0.55 + 0.04"], ["=pr * 0.95", "=poleH * 0.55 + 0.1"],
                ["=topR", "=poleH - 0.12"], ["=topR * 1.5", "=poleH - 0.06"], ["=topR * 1.5", "=poleH"], [0, "=poleH"],
            ],
        },
        { id: "heritagePole", type: "mesh.lathe", when: "=poleStyle == 'heritage' && !isBollard && poleH > 1.4", profile: "@heritageProfile", segments: 28, smoothAngle: 35, region: "pole" },
        { id: "heritageShort", type: "mesh.cone", when: "=poleStyle == 'heritage' && !isBollard && poleH <= 1.4", bottomRadius: "=pr", topRadius: "=topR", height: "=poleH", segments: 24, region: "pole" },
        { id: "basePlate", type: "mesh.box", when: "=poleStyle != 'heritage' && !isBollard", size: ["=pr * 4", 0.025, "=pr * 4"], radius: 0.004, at: [0, 0.0125, 0], region: "pole" },
        { id: "baseBolts", type: "mesh.cylinder", when: "=poleStyle != 'heritage' && !isBollard", repeat: 4, radius: "=pr * 0.18", height: 0.05, segments: 6, at: ["=(index % 2 * 2 - 1) * pr * 1.55", 0.02, "=(floor(index / 2) * 2 - 1) * pr * 1.55"], region: "pole" },
        // ===== Lamp arms: one unit reaching along +X, copied round the pole =======================
        { id: "straightPath", type: "path.points", output: false, points: [[0, "=height - 0.15", 0], ["=tipX", "=tipY", 0]] },
        { id: "sweptPath", type: "path.bezier", output: false, p0: [0, "=armY", 0], p1: [0, "=height + 0.15", 0], p2: ["=tipX * 0.35", "=height + 0.3", 0], p3: ["=tipX", "=tipY", 0], segments: 20 },
        { id: "scrollPath", type: "path.points", output: false, smooth: 6, points: [[0, "=height - 0.05", 0], ["=tipX * 0.5", "=height - 0.03", 0], ["=tipX", "=tipY", 0]] },
        // A curved brace under a scrolled bracket, with a ring between it and the arm.
        { id: "scrollBrace", type: "path.points", output: false, smooth: 6, points: [[0, "=height - 0.05 - reach * 0.5", 0], ["=reach * 0.12", "=height - 0.05 - reach * 0.22", 0], ["=reach * 0.42", "=height - 0.07", 0]] },
        { id: "scrollRing", type: "mesh.torus", output: false, when: "=armStyle == 'scroll'", major: "=reach * 0.075", minor: "=armR * 0.5", segments: 20, sides: 8, rotate: [90, 0, 0], at: ["=reach * 0.27", "=height - 0.06 - reach * 0.1", 0] },
        { id: "arm", type: "mesh.sweep", output: false, path: { switch: "=armStyle", cases: { straight: "@straightPath", swept: "@sweptPath" }, default: "@scrollPath" }, radius: "=armR", sides: 12 },
        { id: "brace", type: "mesh.sweep", output: false, when: "=armStyle == 'scroll'", path: "@scrollBrace", radius: "=armR * 0.6", sides: 8 },
        // Fittings at the arm tip (hung below it), or on the pole top when there are no arms.
        // Cobra head: a long, low housing with a glowing lens underneath.
        { id: "cobraBody", when: "=fitting == 'cobra'", type: "mesh.box", output: false, size: [0.7, 0.14, 0.32], radius: 0.06, segments: 4, at: [0.3, 0, 0], region: "pole" },
        { id: "cobraLens", when: "=fitting == 'cobra'", type: "mesh.box", output: false, size: [0.5, 0.03, 0.24], radius: 0.012, at: [0.33, -0.07, 0], region: "=lampG" },
        // Slim LED: a thin blade with a lit strip.
        { id: "slimBody", when: "=fitting == 'slim'", type: "mesh.box", output: false, size: [0.75, 0.05, 0.2], radius: 0.02, at: [0.32, 0, 0], region: "pole" },
        { id: "slimLens", when: "=fitting == 'slim'", type: "mesh.box", output: false, size: [0.65, 0.012, 0.15], radius: 0.005, at: [0.32, -0.027, 0], region: "=lampG" },
        // Lantern: a cup, four tapering panes, a pyramid roof and a finial (built hanging from its top).
        { id: "lanternCup", when: "=fitting == 'lantern'", type: "mesh.cone", output: false, bottomRadius: 0.08, topRadius: 0.17, height: 0.1, segments: 4, rotate: [0, 45, 0], at: [0, -0.62, 0], region: "pole" },
        { id: "lanternPanes", when: "=fitting == 'lantern'", type: "mesh.cone", output: false, bottomRadius: 0.17, topRadius: 0.24, height: 0.34, segments: 4, rotate: [0, 45, 0], at: [0, -0.52, 0], region: "=lampG" },
        { id: "lanternFrame", when: "=fitting == 'lantern'", type: "mesh.box", output: false, repeat: 4, size: [0.02, 0.36, 0.02], rotate: ["=index < 2 ? (index * 2 - 1) * 6 : 0", 0, "=index >= 2 ? (index * 2 - 5) * 6 : 0"], at: ["=index >= 2 ? (index * 2 - 5) * 0.145 : 0", -0.35, "=index < 2 ? (index * 2 - 1) * 0.145 : 0"], region: "pole" },
        { id: "lanternRoof", when: "=fitting == 'lantern'", type: "mesh.cone", output: false, bottomRadius: 0.3, topRadius: 0.03, height: 0.16, segments: 4, rotate: [0, 45, 0], at: [0, -0.18, 0], region: "pole" },
        { id: "lanternFinial", when: "=fitting == 'lantern'", type: "mesh.sphere", output: false, radius: 0.035, segments: 12, rings: 6, at: [0, -0.02, 0], region: "pole" },
        { id: "lanternHook", when: "=fitting == 'lantern'", type: "mesh.torus", output: false, major: 0.03, minor: 0.008, segments: 12, sides: 6, rotate: [90, 0, 0], at: [0, 0.01, 0], region: "pole" },
        // Globe: a sphere on a neck.
        { id: "globeBall", when: "=fitting == 'globe'", type: "mesh.sphere", output: false, radius: 0.22, segments: 28, rings: 14, at: [0, -0.3, 0], region: "=lampG" },
        { id: "globeNeck", when: "=fitting == 'globe'", type: "mesh.cylinder", output: false, radius: 0.06, height: 0.1, segments: 16, at: [0, -0.1, 0], region: "pole" },
        { id: "lamp", type: "geo.join", output: false, meshes: ["@cobraBody", "@cobraLens", "@slimBody", "@slimLens", "@lanternCup", "@lanternPanes", "@lanternFrame", "@lanternRoof", "@lanternFinial", "@lanternHook", "@globeBall", "@globeNeck"] },
        { id: "armUnitParts", type: "geo.join", output: false, meshes: ["@arm", "@brace", "@scrollRing"] },
        { id: "armUnit", type: "geo.transform", output: false, mesh: "@armUnitParts", region: "pole" },
        { id: "arms", type: "geo.transform", when: "=isLight && arms > 0", repeat: "=arms", mesh: "@armUnit", rotate: [0, "=index * 360 / arms", 0] },
        // Hung lamps tilt with a straight arm; cobra and slim fittings carry on along it.
        { id: "armLamps", type: "geo.transform", when: "=isLight && arms > 0", repeat: "=arms", mesh: "@lamp", rotate: [0, "=index * 360 / arms", "=armStyle == 'straight' && (fitting == 'cobra' || fitting == 'slim') ? 8 : 0"], at: ["=cos(rad(index * 360 / arms)) * (tipX - (fitting == 'cobra' || fitting == 'slim' ? 0.05 : 0))", "=tipY + (fitting == 'cobra' || fitting == 'slim' ? 0 : 0.0)", "=-sin(rad(index * 360 / arms)) * (tipX - (fitting == 'cobra' || fitting == 'slim' ? 0.05 : 0))"] },
        // On the pole top: a lantern or globe stands up (its hanging hook removed by setting it on its cup).
        { id: "topNeck", type: "mesh.cylinder", when: "=isLight && arms == 0", radius: "=topR * 0.8", height: "=fitting == 'globe' ? 0.14 : 0.12", segments: 16, at: [0, "=poleH - 0.01", 0], region: "pole" },
        { id: "topLamp", type: "geo.transform", when: "=isLight && arms == 0", mesh: "@lamp", at: [0, "=fitting == 'globe' ? poleH + 0.52 : poleH + 0.72", 0] },
        // ===== Bollards ===========================================================================
        { id: "bollardBody", type: "mesh.cylinder", when: "=isBollard && bollardStyle != 'heritage'", radius: "=pr", height: "=bollardStyle == 'lit' ? height - 0.2 : height - pr", segments: 32, region: "pole" },
        { id: "bollardDome", type: "mesh.sphere", when: "=isBollard && bollardStyle == 'dome'", radius: "=pr", segments: 32, rings: 16, scale: [1, 0.6, 1], at: [0, "=height - pr", 0], region: "pole" },
        { id: "bollardBands", type: "mesh.cylinder", when: "=isBollard && bollardStyle == 'dome'", repeat: 2, radius: "=pr + 0.002", height: 0.04, segments: 32, at: [0, "=height - pr - 0.12 - index * 0.08", 0], region: "band" },
        { id: "litLouvres", type: "mesh.cylinder", when: "=isBollard && bollardStyle == 'lit'", repeat: 4, radius: "=pr + 0.01", height: 0.012, segments: 32, at: [0, "=height - 0.2 + 0.02 + index * 0.045", 0], region: "pole" },
        { id: "litCore", type: "mesh.cylinder", when: "=isBollard && bollardStyle == 'lit'", radius: "=pr * 0.8", height: 0.18, segments: 24, at: [0, "=height - 0.2", 0], region: "=lit ? 'lamp' : 'glass'" },
        { id: "litCap", type: "mesh.cylinder", when: "=isBollard && bollardStyle == 'lit'", radius: "=pr + 0.015", height: 0.03, segments: 32, bevel: 0.008, at: [0, "=height - 0.03", 0], region: "pole" },
        {
            id: "heritageBollardProfile", type: "curve.points", output: false, fillet: 0.006,
            points: [[0, 0], ["=pr * 1.35", 0], ["=pr * 1.35", 0.06], ["=pr * 1.1", 0.1], ["=pr", "=height * 0.5"], ["=pr * 0.9", "=height * 0.82"], ["=pr * 1.2", "=height * 0.86"], ["=pr * 0.9", "=height * 0.9"], ["=pr * 0.7", "=height * 0.97"], [0, "=height"]],
        },
        { id: "heritageBollard", type: "mesh.lathe", when: "=isBollard && bollardStyle == 'heritage'", profile: "@heritageBollardProfile", segments: 32, smoothAngle: 40, region: "pole" },
        // ===== Signs ==============================================================================
        { id: "signRect", type: "curve.rect", output: false, width: "=sz", height: "=sz * (kind == 'stop' ? 0.6 : 0.7)", radius: "=sz * 0.04", cornerSegments: 4 },
        { id: "signCircle", type: "curve.circle", output: false, radius: "=sz / 2", segments: 40 },
        { id: "signTri", type: "curve.polygon", output: false, radius: "=sz * 0.58", sides: 3, rotation: 90 },
        { id: "signOct", type: "curve.polygon", output: false, radius: "=sz / 2 / cos(rad(22.5))", sides: 8, rotation: 22.5 },
        // A plate in the border colour, with a slightly smaller face in the sign colour on top.
        { id: "plateShape", type: "mesh.extrude", output: false, outline: { switch: "=kind == 'stop' ? 'rectangle' : signShape", cases: { circle: "@signCircle", triangle: "@signTri", octagon: "@signOct" }, default: "@signRect" }, height: 0.004, region: "face" },
        { id: "faceShape", type: "mesh.extrude", output: false, outline: { switch: "=kind == 'stop' ? 'rectangle' : signShape", cases: { circle: "@signCircle", triangle: "@signTri", octagon: "@signOct" }, default: "@signRect" }, height: 0.002, scale: [0.88, 1, 0.88], at: [0, 0.004, "=signShape == 'triangle' && kind != 'stop' ? -sz * 0.035 : 0"], region: "sign" },
        { id: "signPlate", type: "geo.join", output: false, meshes: ["@plateShape", "@faceShape"] },
        // Stood up facing +Z just in front of the pole, one above the other.
        { id: "signPlates", type: "geo.transform", when: "=isSign", repeat: "=kind == 'stop' ? 1 : signs", mesh: "@signPlate", rotate: [90, 0, 0], at: [0, "=signY - index * sz * 1.05", "=pr + 0.012"] },
        { id: "signClamps", type: "mesh.box", when: "=isSign", repeat: "=(kind == 'stop' ? 1 : signs) * 2", size: ["=pr * 2.4", 0.03, "=pr * 2.2 + 0.012"], radius: 0.004, at: [0, "=signY - floor(index / 2) * sz * 1.05 + (index % 2 * 2 - 1) * sz * 0.22", 0.004], region: "pole" },
        // Transit stop: a timetable case on the pole below the flag.
        { id: "caseBox", type: "mesh.box", when: "=kind == 'stop'", size: [0.36, 0.5, 0.05], radius: 0.01, at: [0, "=height * 0.55", "=pr + 0.03"], region: "pole" },
        { id: "casePaper", type: "mesh.box", when: "=kind == 'stop'", size: [0.3, 0.42, 0.004], at: [0, "=height * 0.55", "=pr + 0.056"], region: "case" },
        { id: "poleCap", type: "mesh.sphere", when: "=isSign", radius: "=pr * 1.05", segments: 12, rings: 6, scale: [1, 0.5, 1], at: [0, "=height", 0], region: "pole" },
    ],
    limits: { maxSize: 15, minSize: 0.4, maxTriangles: 40000 },
};

export default streetlight;
