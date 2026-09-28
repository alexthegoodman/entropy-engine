import type { ObjectDef } from "../mesha_object";

/** A dining/side/coffee table: top shape, edge, legs (composed from component.leg) or a pedestal, apron. */
const table: ObjectDef = {
    id: "furniture.table",
    name: "Table",
    category: "Furniture",
    tags: ["table", "dining table", "desk", "coffee table", "side table", "kitchen table"],
    description: "Rectangular, rounded, oval or round top on four legs or a pedestal.",
    featured: ["width", "depth", "height", "topShape", "legStyle", "topFinish", "legFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "top", label: "Top" },
        { id: "legs", label: "Legs" },
        { id: "apron", label: "Apron" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "width", label: "Width", type: "number", default: 1.6, min: 0.4, max: 3.2, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 0.9, min: 0.4, max: "=topShape == 'round' ? 3.2 : 1.6", unit: "m", group: "size", visibleIf: "=topShape != 'round'" },
        { id: "height", label: "Height", type: "number", default: 0.75, min: 0.3, max: 1.1, unit: "m", group: "size" },
        { id: "topShape", label: "Top shape", type: "enum", default: "rounded", options: ["rectangle", "rounded", "oval", "round"], optionLabels: ["Rectangle", "Rounded", "Soft oval", "Round"], group: "top" },
        { id: "cornerRadius", label: "Corner radius", type: "number", default: 0.08, min: "=topThickness * edgeRound * 0.5 + 0.004", max: "=min(width, depth) * 0.45", unit: "m", group: "top", visibleIf: "=topShape == 'rounded'" },
        { id: "topThickness", label: "Thickness", type: "number", default: 0.035, min: 0.015, max: 0.09, unit: "m", group: "top" },
        { id: "edgeRound", label: "Edge rounding", type: "number", default: 0.35, min: 0, max: 0.95, group: "top" },
        { id: "overhang", label: "Overhang", type: "number", default: 0.06, min: 0, max: 0.3, unit: "m", group: "top", visibleIf: "=legStyle != 'pedestal'" },
        { id: "legStyle", label: "Leg style", type: "enum", default: "tapered", options: ["square", "tapered", "round", "turned", "hairpin", "pedestal"], optionLabels: ["Square", "Tapered", "Round", "Turned", "Hairpin", "Pedestal"], group: "legs" },
        { id: "legThickness", label: "Leg thickness", type: "number", default: 0.055, min: 0.025, max: 0.12, unit: "m", group: "legs" },
        { id: "splay", label: "Splay", type: "number", default: 0, min: 0, max: 14, unit: "°", group: "legs", visibleIf: "=legStyle != 'pedestal' && legStyle != 'hairpin'" },
        { id: "legTaper", label: "Foot size", type: "number", default: 0.6, min: 0.35, max: 1, group: "legs", visibleIf: "=legStyle == 'tapered' || legStyle == 'round'" },
        { id: "pedestalFeet", label: "Feet", type: "int", default: 4, min: 3, max: 6, group: "legs", visibleIf: "=legStyle == 'pedestal'" },
        { id: "apron", label: "Apron", type: "bool", default: true, group: "apron", visibleIf: "=legStyle != 'pedestal' && legStyle != 'hairpin'" },
        { id: "apronHeight", label: "Apron height", type: "number", default: 0.09, min: 0.03, max: 0.2, unit: "m", group: "apron", visibleIf: "=apron && legStyle != 'pedestal' && legStyle != 'hairpin'" },
        { id: "topFinish", label: "Top", type: "material", default: "wood.oak", materials: ["wood", "paint", "stone.marble", "stone.slate", "glass.clear"], group: "materials" },
        { id: "legFinish", label: "Legs", type: "material", default: "wood.oak", materials: ["wood", "paint", "metal"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 7, group: "materials", variation: 0 },
    ],
    derived: {
        d: "=topShape == 'round' ? width : depth",
        legH: "=height - topThickness",
        // Oval and round tops keep their legs inside the curve.
        legSpread: "=topShape == 'oval' || topShape == 'round' ? 0.68 : 1",
        // Big rounded corners cut in along the diagonal by 0.293 R: keep the legs inside the curve.
        cornerInset: "=topShape == 'rounded' ? cornerRadius * 0.293 + 0.015 : 0",
        legX: "=max(0.02, min(width / 2 - overhang, width / 2 - cornerInset) * legSpread - legThickness / 2)",
        legZ: "=max(0.02, min(d / 2 - overhang, d / 2 - cornerInset) * legSpread - legThickness / 2)",
        hasApron: "=apron && legStyle != 'pedestal' && legStyle != 'hairpin'",
        splayRad: "=rad(legStyle == 'hairpin' || legStyle == 'pedestal' ? 0 : splay)",
        apronT: "=clamp(legThickness * 0.4, 0.016, 0.03)",
        pedR: "=min(width, d) * 0.12",
    },
    rules: [
        { check: "=legX > legThickness && legZ > legThickness", message: "The legs crowd into each other: make the top larger or the overhang smaller." },
        { check: "=legStyle != 'pedestal' || min(width, d) <= 1.6", message: "A pedestal can't carry a top that large." },
        { check: "=height > topThickness + 0.2", message: "The table is too low for its top." },
        { check: "=max(width, d) / height < 4.5 || height < 0.5", message: "Too long for its height to read as a table." },
    ],
    regions: {
        top: { label: "Top", material: "=topFinish" },
        legs: { label: "Legs", material: "=legFinish" },
    },
    presets: [
        { name: "Farmhouse dining", values: { width: 2.0, depth: 0.95, topShape: "rectangle", topThickness: 0.05, legStyle: "turned", legThickness: 0.085, apron: true, apronHeight: 0.12, topFinish: "wood.oak", legFinish: "paint.white", edgeRound: 0.2 } },
        { name: "Mid-century coffee", values: { width: 1.2, depth: 0.6, height: 0.42, topShape: "oval", legStyle: "tapered", legThickness: 0.045, splay: 10, apron: false, topFinish: "wood.walnut", legFinish: "wood.walnut", edgeRound: 0.6 } },
        { name: "Bistro round", values: { width: 0.75, height: 0.74, topShape: "round", legStyle: "pedestal", pedestalFeet: 4, topFinish: "stone.marble", legFinish: "metal.black" } },
        { name: "Workshop desk", values: { width: 1.5, depth: 0.75, topShape: "rounded", cornerRadius: 0.03, legStyle: "hairpin", legThickness: 0.08, topFinish: "wood.ash", legFinish: "metal.black" } },
    ],
    nodes: [
        { id: "rectTop", type: "curve.rect", output: false, width: "=width", height: "=d", radius: "=topShape == 'rounded' ? cornerRadius : topThickness * edgeRound * 0.5 + 0.003", cornerSegments: 8 },
        { id: "ovalTop", type: "curve.superellipse", output: false, width: "=width", height: "=d", exponent: "=topShape == 'round' ? 2 : 2.6", segments: 96 },
        {
            id: "top", type: "mesh.extrude", region: "top",
            outline: { if: "=topShape == 'oval' || topShape == 'round'", then: "@ovalTop", else: "@rectTop" },
            height: "=topThickness", bevel: "=topThickness * edgeRound * 0.5", bevelSegments: 4, at: [0, "=legH", 0],
        },
        // Four legs: index 0..3 picks the corner; splayed legs lean in at the top.
        {
            id: "legs", type: "object", object: "component.leg", repeat: "=legStyle == 'pedestal' ? 0 : 4", region: "legs", rest: true,
            params: { height: "=legH / cos(splayRad)", thickness: "=legThickness", style: "=legStyle", taper: "=legTaper" },
            at: ["=(index % 2 * 2 - 1) * (legX + legH * tan(splayRad) * 0.7)", 0, "=(floor(index / 2) * 2 - 1) * (legZ + legH * tan(splayRad) * 0.7)"],
            rotate: ["=-(floor(index / 2) * 2 - 1) * splay * 0.7", "=legStyle == 'hairpin' ? (index % 2 * 2 - 1) * (floor(index / 2) * 2 - 1) * 45 : 0", "=(index % 2 * 2 - 1) * splay * 0.7"],
        },
        {
            id: "apronLong", type: "mesh.box", when: "=hasApron", repeat: 2, region: "legs",
            size: ["=legX * 2", "=apronHeight", "=apronT"], radius: 0.003,
            at: [0, "=legH - apronHeight / 2", "=(index * 2 - 1) * (legZ + legThickness / 2 - apronT / 2 - 0.004)"],
        },
        {
            id: "apronShort", type: "mesh.box", when: "=hasApron", repeat: 2, region: "legs",
            size: ["=apronT", "=apronHeight", "=legZ * 2"], radius: 0.003,
            at: ["=(index * 2 - 1) * (legX + legThickness / 2 - apronT / 2 - 0.004)", "=legH - apronHeight / 2", 0],
        },
        // Pedestal: a turned column on splayed feet.
        {
            id: "columnProfile", type: "curve.points", output: false, smooth: 6,
            points: [["=pedR * 0.55", 0], ["=pedR * 0.5", "=legH * 0.12"], ["=pedR * 0.34", "=legH * 0.3"], ["=pedR * 0.3", "=legH * 0.7"], ["=pedR * 0.45", "=legH * 0.92"], ["=pedR * 0.9", "=legH - 0.012"], ["=pedR * 0.9", "=legH"]],
        },
        { id: "column", type: "mesh.lathe", when: "=legStyle == 'pedestal'", profile: "@columnProfile", cap: true, segments: 40, region: "legs" },
        {
            id: "footPath", type: "path.points", output: false, smooth: 6,
            points: [[0, "=legH * 0.1", 0], ["=min(width, d) * 0.2", "=legH * 0.05", 0], ["=min(width, d) * 0.34", 0.012, 0]],
        },
        { id: "foot", type: "mesh.sweep", output: false, path: "@footPath", profile: "@footProfile", taper: 0.55 },
        { id: "footProfile", type: "curve.rect", output: false, width: "=pedR * 0.6", height: "=pedR * 0.5", radius: "=pedR * 0.2", cornerSegments: 4 },
        { id: "feet", type: "instance.radial", when: "=legStyle == 'pedestal'", mesh: "@foot", count: "=pedestalFeet", startAngle: 45, rest: true, region: "legs" },
    ],
    limits: { maxSize: 3.4, minSize: 0.25, maxTriangles: 60000 },
};

export default table;
