import type { ObjectDef } from "../mesha_object";

// Openings are drawn as 2D outlines in (x, up) and extruded through the wall's depth: rotating an
// extrusion -90 degrees about X turns its outline's second axis into world up and its thickness
// into -Z, so every panel below is placed at z = +depth / 2 to centre it on the wall plane.

/** A window facing +Z, bottom of the frame at the origin: casement, sash or fixed, square or arched, with glazing bars. */
export const windowDef: ObjectDef = {
    id: "architecture.window",
    name: "Window",
    category: "Architecture",
    tags: ["window", "casement", "sash window", "arched window", "glazing", "building"],
    description: "Casement, sash or fixed window, square or arched, with glazing bars and a sill.",
    featured: ["width", "height", "style", "arch", "panesX", "panesY", "frameFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "frame", label: "Frame" },
        { id: "glazing", label: "Glazing bars" },
        { id: "sill", label: "Sill" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "width", label: "Width", type: "number", default: 0.9, min: 0.35, max: 2.4, unit: "m", group: "size" },
        { id: "height", label: "Height", type: "number", default: 1.3, min: 0.35, max: 2.6, unit: "m", group: "size" },
        { id: "style", label: "Opening", type: "enum", default: "casement", options: ["casement", "sash", "fixed"], optionLabels: ["Casement", "Sash", "Fixed"], group: "frame" },
        { id: "arch", label: "Arch", type: "number", default: 0, min: 0, max: "=min(width / 2, height * 0.45)", unit: "m", group: "frame", description: "How high the top arches (half the width is a semicircle)." },
        { id: "frameWidth", label: "Frame width", type: "number", default: 0.06, min: 0.03, max: 0.14, unit: "m", group: "frame" },
        { id: "depth", label: "Depth", type: "number", default: 0.1, min: 0.04, max: 0.3, unit: "m", group: "frame" },
        { id: "panesX", label: "Panes across", type: "int", default: 2, min: 1, max: 6, group: "glazing" },
        { id: "panesY", label: "Panes down", type: "int", default: 3, min: 1, max: 8, group: "glazing" },
        { id: "bar", label: "Bar width", type: "number", default: 0.022, min: 0.01, max: 0.05, unit: "m", group: "glazing", visibleIf: "=panesX > 1 || panesY > 1" },
        { id: "sill", label: "Sill", type: "bool", default: true, group: "sill" },
        { id: "sillDepth", label: "Sill projection", type: "number", default: 0.06, min: 0.02, max: 0.2, unit: "m", group: "sill", visibleIf: "=sill" },
        { id: "frameFinish", label: "Frame", type: "material", default: "paint.white", materials: ["paint", "wood", "metal.black", "metal.aluminum"], group: "materials" },
        { id: "glass", label: "Glass", type: "material", default: "glass.clear", materials: ["glass"], group: "materials" },
        { id: "sillFinish", label: "Sill", type: "material", default: "stone.sandstone", materials: ["stone", "wood", "paint"], group: "materials", visibleIf: "=sill" },
        { id: "seed", label: "Seed", type: "seed", default: 2, group: "materials", variation: 0 },
    ],
    derived: {
        fw: "=frameWidth",
        innerW: "=width - 2 * fw",
        innerH: "=height - 2 * fw",
        innerRise: "=max(0, arch - fw * 0.6)",
        // The square part of the opening, below where an arch springs.
        rectTop: "=height - fw - (arch > 0.001 ? arch : 0)",
        opens: "=style != 'fixed'",
        sashFw: "=fw * 0.7",
    },
    rules: [
        { check: "=innerW > 0.12 && innerH > 0.12", message: "The frame leaves almost no glass: narrow the frame or enlarge the window." },
        { check: "=innerW / panesX > bar * 3 && (rectTop - fw) / panesY > bar * 3", message: "Too many glazing bars for the opening." },
        { check: "=style != 'sash' || arch < 0.001 || rectTop > height * 0.5", message: "A sash needs a square lower half to slide in." },
    ],
    regions: {
        frame: { label: "Frame", material: "=frameFinish" },
        glass: { label: "Glass", material: "=glass" },
        sill: { label: "Sill", material: "=sillFinish" },
        hardware: { label: "Handle", material: "metal.brass" },
    },
    presets: [
        { name: "Georgian sash", values: { width: 0.95, height: 1.6, style: "sash", panesX: 3, panesY: 4, frameFinish: "paint.white", bar: 0.018 } },
        { name: "Arched chapel", values: { width: 0.8, height: 1.8, style: "fixed", arch: 0.4, panesX: 2, panesY: 4, frameFinish: "wood.walnut", sillFinish: "stone.granite" } },
        { name: "Modern picture", values: { width: 1.8, height: 1.4, style: "fixed", panesX: 1, panesY: 1, frameWidth: 0.045, frameFinish: "metal.black", sill: false } },
        { name: "Cottage casement", values: { width: 0.8, height: 0.95, style: "casement", panesX: 2, panesY: 2, frameFinish: "paint.sage", sillFinish: "wood.oak" } },
    ],
    nodes: [
        { id: "outer", type: "curve.arch", output: false, width: "=width", height: "=height", rise: "=arch", segments: 32 },
        { id: "innerShape", type: "curve.arch", output: false, width: "=innerW", height: "=innerH", rise: "=innerRise", segments: 32 },
        { id: "inner", type: "curve.transform", output: false, curve: "@innerShape", offset: [0, "=fw"] },
        {
            id: "frame", type: "mesh.extrude", outline: "@outer", holes: ["@inner"], height: "=depth", bevel: "=min(fw * 0.12, 0.006)", bevelSegments: 2, smoothAngle: 30,
            rotate: [-90, 0, 0], at: [0, 0, "=depth / 2"], region: "frame",
        },
        { id: "pane", type: "mesh.extrude", outline: "@inner", height: 0.006, rotate: [-90, 0, 0], at: [0, 0, 0.003], region: "glass" },
        // Sashes: two side-hung leaves (casement) or two stacked sliding sashes (sash), in the square part.
        { id: "sashRing", type: "curve.rect", output: false, width: "=style == 'casement' ? innerW / 2 : innerW", height: "=style == 'casement' ? rectTop - fw : (rectTop - fw) / 2", radius: 0.002 },
        { id: "sashHole", type: "curve.rect", output: false, width: "=(style == 'casement' ? innerW / 2 : innerW) - 2 * sashFw", height: "=(style == 'casement' ? rectTop - fw : (rectTop - fw) / 2) - 2 * sashFw", radius: 0.002 },
        {
            id: "sashes", type: "mesh.extrude", when: "=opens", repeat: 2, outline: "@sashRing", holes: ["@sashHole"], height: "=depth * 0.45", bevel: 0.003, bevelSegments: 2,
            rotate: [-90, 0, 0], region: "frame",
            at: [
                "=style == 'casement' ? (index - 0.5) * innerW / 2 : 0",
                "=style == 'casement' ? fw + (rectTop - fw) / 2 : fw + (rectTop - fw) * (index + 0.5) / 2",
                "=depth * 0.225 + (style == 'sash' ? (index - 0.5) * depth * 0.2 : 0)",
            ],
        },
        // Glazing bars across the whole opening (the vertical ones stop where an arch springs).
        { id: "barsV", type: "mesh.box", repeat: "=panesX - 1", size: ["=bar", "=rectTop - fw", "=depth * 0.3"], radius: 0.002, at: ["=-innerW / 2 + innerW * (index + 1) / panesX", "=fw + (rectTop - fw) / 2", 0], region: "frame" },
        { id: "barsH", type: "mesh.box", repeat: "=panesY - 1", size: ["=innerW", "=bar", "=depth * 0.3"], radius: 0.002, at: [0, "=fw + (rectTop - fw) * (index + 1) / panesY", 0], region: "frame" },
        { id: "transom", type: "mesh.box", when: "=arch > 0.001", size: ["=innerW", "=bar * 1.4", "=depth * 0.5"], radius: 0.002, at: [0, "=rectTop", 0], region: "frame" },
        { id: "handle", type: "mesh.box", when: "=style == 'casement'", size: [0.012, 0.09, 0.02], radius: 0.005, at: ["=innerW / 2 - sashFw - 0.02", "=fw + (rectTop - fw) / 2", "=depth * 0.47 + 0.012"], region: "hardware" },
        { id: "sill", type: "mesh.box", when: "=sill", size: ["=width + 0.08", 0.035, "=depth + sillDepth"], radius: 0.006, segments: 2, at: [0, -0.0175, "=sillDepth / 2"], region: "sill" },
    ],
    // The sill hangs below the frame's origin: a window isn't meant to stand on the floor.
    limits: { maxSize: 3, minSize: 0.3, maxTriangles: 40000, floor: false },
};

/** A stretch of wall with a row of openings, each holding a composed Window: "Window count 4 -> 6". */
export const facadeDef: ObjectDef = {
    id: "architecture.facade",
    name: "Facade",
    category: "Architecture",
    tags: ["facade", "wall", "building", "house front", "windows", "architecture", "storey"],
    description: "A wall with a row of windows (each a procedural Window), plinth and cornice.",
    featured: ["windowCount", "spacing", "storeyHeight", "windowWidth", "windowHeight", "arch", "wallFinish"],
    groups: [
        { id: "wall", label: "Wall" },
        { id: "windows", label: "Windows" },
        { id: "details", label: "Details" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "windowCount", label: "Window count", type: "int", default: 4, min: 1, max: 10, group: "windows" },
        { id: "spacing", label: "Spacing", type: "number", default: 1.6, min: "=windowWidth + 0.3", max: 4, unit: "m", group: "windows" },
        { id: "windowWidth", label: "Window width", type: "number", default: 0.9, min: 0.4, max: 2.2, unit: "m", group: "windows" },
        { id: "windowHeight", label: "Window height", type: "number", default: 1.4, min: 0.4, max: "=storeyHeight - 0.5", unit: "m", group: "windows" },
        { id: "sillHeight", label: "Sill height", type: "number", default: 0.85, min: 0.1, max: "=storeyHeight - windowHeight - 0.2", unit: "m", group: "windows" },
        { id: "arch", label: "Arch", type: "number", default: 0, min: 0, max: "=min(windowWidth / 2, windowHeight * 0.45)", unit: "m", group: "windows" },
        { id: "windowStyle", label: "Opening", type: "enum", default: "sash", options: ["casement", "sash", "fixed"], optionLabels: ["Casement", "Sash", "Fixed"], group: "windows" },
        { id: "panesX", label: "Panes across", type: "int", default: 2, min: 1, max: 5, group: "windows" },
        { id: "panesY", label: "Panes down", type: "int", default: 3, min: 1, max: 6, group: "windows" },
        { id: "storeyHeight", label: "Storey height", type: "number", default: 3, min: 2.2, max: 5, unit: "m", group: "wall" },
        { id: "margin", label: "End margin", type: "number", default: 0.7, min: 0.2, max: 3, unit: "m", group: "wall" },
        { id: "thickness", label: "Wall thickness", type: "number", default: 0.3, min: 0.12, max: 0.6, unit: "m", group: "wall" },
        { id: "plinth", label: "Plinth", type: "bool", default: true, group: "details" },
        { id: "cornice", label: "Cornice", type: "bool", default: true, group: "details" },
        { id: "wallFinish", label: "Wall", type: "material", default: "paint.terracotta", materials: ["paint", "stone"], group: "materials" },
        { id: "trimFinish", label: "Plinth & cornice", type: "material", default: "stone.sandstone", materials: ["stone", "paint"], group: "materials" },
        { id: "windowFinish", label: "Window frames", type: "material", default: "paint.white", materials: ["paint", "wood", "metal.black"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 9, group: "materials", variation: 0 },
    ],
    derived: {
        wallW: "=(windowCount - 1) * spacing + windowWidth + 2 * margin",
        winDepth: "=thickness * 0.4",
    },
    rules: [
        { check: "=spacing - windowWidth >= 0.3", message: "Windows need at least 30 cm of wall between them." },
        { check: "=wallW < 30", message: "The wall is longer than a single facade usually runs." },
        { check: "=windowHeight >= storeyHeight * 0.35", message: "Windows this short read as vents on a storey this tall." },
        { check: "=sillHeight <= 1.2", message: "Sills this high hide the view." },
        { check: "=windowWidth >= windowHeight * 0.38", message: "Windows this narrow read as arrow slits." },
    ],
    regions: {
        wall: { label: "Wall", material: "=wallFinish" },
        trim: { label: "Plinth & cornice", material: "=trimFinish" },
        frame: { label: "Window frames", material: "=windowFinish" },
        glass: { label: "Glass", material: "glass.clear" },
        sill: { label: "Sills", material: "=trimFinish" },
        hardware: { label: "Handles", material: "metal.brass" },
    },
    presets: [
        { name: "Townhouse", values: { windowCount: 3, spacing: 1.5, windowWidth: 0.95, windowHeight: 1.7, windowStyle: "sash", panesX: 3, panesY: 4, wallFinish: "paint.white", trimFinish: "stone.slate", windowFinish: "paint.black" } },
        { name: "Arcade", values: { windowCount: 6, spacing: 1.3, windowWidth: 0.8, windowHeight: 2.0, sillHeight: 0.35, arch: 0.4, windowStyle: "fixed", panesX: 2, panesY: 3, storeyHeight: 3.2, wallFinish: "stone.sandstone", trimFinish: "stone.granite", windowFinish: "wood.walnut" } },
    ],
    nodes: [
        { id: "wallOutline", type: "curve.rect", output: false, width: "=wallW", height: "=storeyHeight" },
        { id: "wallShape", type: "curve.transform", output: false, curve: "@wallOutline", offset: [0, "=storeyHeight / 2"] },
        { id: "openingShape", type: "curve.arch", output: false, width: "=windowWidth - 0.004", height: "=windowHeight - 0.004", rise: "=arch", segments: 32 },
        { id: "opening", type: "curve.transform", output: false, curve: "@openingShape", offset: [0, "=sillHeight + 0.002"] },
        { id: "openings", type: "curves.linear", output: false, curve: "@opening", count: "=windowCount", offset: ["=spacing", 0] },
        { id: "wall", type: "mesh.extrude", outline: "@wallShape", holes: ["@openings"], height: "=thickness", bevel: 0.004, bevelSegments: 1, smoothAngle: 20, rotate: [-90, 0, 0], at: [0, 0, "=thickness / 2"], region: "wall" },
        {
            id: "windows", type: "object", object: "architecture.window", repeat: "=windowCount",
            params: { width: "=windowWidth", height: "=windowHeight", arch: "=arch", style: "=windowStyle", panesX: "=panesX", panesY: "=panesY", depth: "=winDepth", sillDepth: "=thickness * 0.3 + 0.04", frameWidth: 0.06 },
            at: ["=(index - (count - 1) / 2) * spacing", "=sillHeight", "=thickness * 0.1"],
        },
        { id: "plinth", type: "mesh.box", when: "=plinth", size: ["=wallW + 0.04", 0.35, "=thickness + 0.04"], radius: 0.008, segments: 2, at: [0, 0.175, 0], region: "trim" },
        { id: "cornice", type: "mesh.box", when: "=cornice", size: ["=wallW + 0.12", 0.18, "=thickness + 0.14"], radius: 0.01, segments: 2, at: [0, "=storeyHeight - 0.09", 0], region: "trim" },
    ],
    limits: { maxSize: 32, minSize: 1, maxTriangles: 250000 },
};
