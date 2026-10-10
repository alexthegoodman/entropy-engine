import type { ObjectDef } from "../mesha_object";

/**
 * A bed: a frame on legs, a panelled box or a low platform; a slatted base under a mattress and
 * topper; a panel, spindle or padded (optionally tufted) headboard and a footboard; bedding as a
 * rigid duvet turned down at the head with pillows; under-bed drawers; or a bunk with a second deck,
 * a guard rail and a ladder. The head is at -Z, the foot at +Z.
 */
const bed: ObjectDef = {
    id: "furniture.bed",
    name: "Bed",
    category: "Furniture",
    tags: ["bed", "double bed", "single bed", "king bed", "bunk bed", "mattress", "headboard", "bedroom", "platform bed", "daybed"],
    description: "Single to king beds and bunks: frame, mattress, headboard, bedding and storage.",
    featured: ["width", "length", "frame", "headboard", "bedding", "pillows", "bunk", "frameFinish", "beddingFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "frame", label: "Frame" },
        { id: "ends", label: "Headboard and footboard" },
        { id: "bedding", label: "Mattress and bedding" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "width", label: "Mattress width", type: "number", default: 1.4, min: 0.75, max: 2.0, unit: "m", group: "size" },
        { id: "length", label: "Mattress length", type: "number", default: 2.0, min: 1.6, max: 2.2, unit: "m", group: "size" },
        { id: "deckHeight", label: "Mattress base height", type: "number", default: 0.32, min: 0.1, max: 0.55, unit: "m", group: "size", description: "Where the mattress rests." },
        { id: "frame", label: "Frame", type: "enum", default: "legs", options: ["legs", "panel", "platform"], optionLabels: ["On legs", "Panelled box", "Low platform"], group: "frame" },
        { id: "legStyle", label: "Leg style", type: "enum", default: "tapered", options: ["square", "tapered", "round", "turned"], optionLabels: ["Square", "Tapered", "Round", "Turned"], group: "frame", visibleIf: "=frame == 'legs'" },
        { id: "railHeight", label: "Rail height", type: "number", default: 0.14, min: 0.06, max: 0.35, unit: "m", group: "frame", visibleIf: "=frame != 'platform'" },
        { id: "storage", label: "Under-bed drawers", type: "bool", default: false, group: "frame", visibleIf: "=frame == 'panel' && !bunk" },
        { id: "drawerOpen", label: "Drawers open", type: "number", default: 0, min: 0, max: 1, group: "frame", variation: 0.3, visibleIf: "=storage && frame == 'panel' && !bunk" },
        { id: "bunk", label: "Bunk", type: "bool", default: false, group: "frame", visibleIf: "=width <= 1.4 && frame == 'legs'" },
        { id: "headboard", label: "Headboard", type: "enum", default: "upholstered", options: ["none", "panel", "spindles", "upholstered"], optionLabels: ["None", "Panel", "Spindles", "Padded"], group: "ends" },
        { id: "headHeight", label: "Headboard height", type: "number", default: 1.1, min: 0.6, max: 1.6, unit: "m", group: "ends", visibleIf: "=headboard != 'none'" },
        { id: "tufted", label: "Button tufting", type: "bool", default: false, group: "ends", visibleIf: "=headboard == 'upholstered'" },
        { id: "footboard", label: "Footboard", type: "bool", default: false, group: "ends" },
        { id: "footHeight", label: "Footboard height", type: "number", default: 0.6, min: 0.35, max: 1.0, unit: "m", group: "ends", visibleIf: "=footboard" },
        { id: "mattress", label: "Mattress thickness", type: "number", default: 0.24, min: 0.08, max: 0.36, unit: "m", group: "bedding" },
        { id: "topper", label: "Topper", type: "bool", default: false, group: "bedding" },
        { id: "bedding", label: "Bedding", type: "enum", default: "duvet", options: ["none", "sheet", "duvet"], optionLabels: ["Bare mattress", "Fitted sheet", "Duvet"], group: "bedding" },
        { id: "pillows", label: "Pillows", type: "int", default: 2, min: 0, max: 4, group: "bedding", visibleIf: "=bedding != 'none'" },
        { id: "frameFinish", label: "Frame", type: "material", default: "wood.oak", materials: ["wood", "paint", "metal.black", "metal.brass", "fabric", "leather"], group: "materials" },
        { id: "upholstery", label: "Headboard", type: "material", default: "fabric.charcoal", materials: ["fabric", "leather"], group: "materials", visibleIf: "=headboard == 'upholstered'" },
        { id: "mattressFinish", label: "Mattress", type: "material", default: "fabric.white", materials: ["fabric.white", "fabric.heather", "canvas.white"], group: "materials" },
        { id: "beddingFinish", label: "Duvet", type: "material", default: "fabric.sky", materials: ["fabric", "knit"], group: "materials", visibleIf: "=bedding == 'duvet'" },
        { id: "sheetFinish", label: "Sheets and pillows", type: "material", default: "fabric.white", materials: ["fabric"], group: "materials", visibleIf: "=bedding != 'none'" },
        { id: "seed", label: "Seed", type: "seed", default: 12, group: "materials", variation: 0 },
    ],
    derived: {
        W: "=width",
        L: "=length",
        rt: "=clamp(W * 0.03, 0.03, 0.05)",
        // The frame's outside: mattress plus rails.
        FW: "=W + 2 * rt",
        FL: "=L + 2 * rt",
        y0: "=deckHeight",
        rh: "=frame == 'platform' ? y0 : min(railHeight, y0 - 0.02)",
        slatT: 0.018,
        nSlats: "=clamp(round(L / 0.09), 8, 30)",
        tt: "=topper ? 0.05 : 0",
        mTop: "=mattress + tt",
        post: "=clamp(W * 0.04, 0.045, 0.08)",
        isBunk: "=bunk && width <= 1.4 && frame == 'legs'",
        upperY: "=y0 + 1.0",
        headTop: "=isBunk ? upperY + mTop + 0.42 : headHeight",
        footTop: "=isBunk ? upperY + mTop + 0.42 : footHeight",
        hasHead: "=headboard != 'none' || isBunk",
        hasFoot: "=footboard || isBunk",
        // A duvet over the foot two thirds, turned down at the head, hanging over the sides.
        dt: 0.035,
        drop: "=min(mTop + 0.12, y0 + mTop - 0.04)",
        coverL: "=L * 0.72",
        nDrawers: "=clamp(floor(L / 0.65), 1, 3)",
        dw: "=(L - 0.1) / nDrawers - 0.01",
        dOpen: "=drawerOpen * (W * 0.5)",
        tuftCols: "=clamp(round(W / 0.18), 4, 14)",
        tuftRows: "=clamp(round((headHeight - y0 - mTop - 0.1) / 0.16), 1, 6)",
    },
    rules: [
        { check: "=!hasHead || isBunk || headHeight > y0 + mTop + 0.2", message: "The headboard hides behind the mattress." },
        { check: "=!footboard || isBunk || footHeight > y0 + 0.08", message: "The footboard is lower than the rails." },
        { check: "=y0 + mTop < 0.85", message: "The mattress is too high to climb onto." },
        { check: "=!(storage && frame == 'panel') || y0 >= 0.26", message: "Raise the base for drawers to fit underneath." },
    ],
    regions: {
        frame: { label: "Frame", material: "=frameFinish" },
        headboard: { label: "Headboard", material: "=headboard == 'upholstered' ? upholstery : frameFinish" },
        mattress: { label: "Mattress", material: "=mattressFinish" },
        duvet: { label: "Duvet", material: "=beddingFinish" },
        sheets: { label: "Sheets and pillows", material: "=sheetFinish" },
        handles: { label: "Drawer handles", material: "metal.brass" },
    },
    presets: [
        { name: "Upholstered double", values: { width: 1.4, length: 2.0, deckHeight: 0.32, frame: "panel", railHeight: 0.22, headboard: "upholstered", headHeight: 1.15, tufted: true, footboard: false, mattress: 0.24, bedding: "duvet", pillows: 2, frameFinish: "fabric.charcoal", upholstery: "fabric.charcoal", beddingFinish: "fabric.white", sheetFinish: "fabric.white" } },
        { name: "Farmhouse spindle bed", values: { width: 1.5, length: 2.0, deckHeight: 0.36, frame: "legs", legStyle: "turned", railHeight: 0.16, headboard: "spindles", headHeight: 1.2, footboard: true, footHeight: 0.75, mattress: 0.26, topper: true, bedding: "duvet", pillows: 4, frameFinish: "paint.white", beddingFinish: "fabric.sky" } },
        { name: "Low platform", values: { width: 1.6, length: 2.0, deckHeight: 0.16, frame: "platform", headboard: "panel", headHeight: 0.8, footboard: false, mattress: 0.2, bedding: "duvet", pillows: 2, frameFinish: "wood.walnut", beddingFinish: "fabric.olive" } },
        { name: "Single with storage", values: { width: 0.9, length: 1.9, deckHeight: 0.4, frame: "panel", railHeight: 0.3, storage: true, drawerOpen: 0.4, headboard: "panel", headHeight: 0.95, mattress: 0.2, bedding: "duvet", pillows: 1, frameFinish: "paint.sage", beddingFinish: "fabric.mustard" } },
        { name: "Bunk beds", values: { width: 0.9, length: 1.9, deckHeight: 0.28, frame: "legs", legStyle: "square", railHeight: 0.14, bunk: true, headboard: "panel", footboard: true, mattress: 0.16, bedding: "duvet", pillows: 1, frameFinish: "wood.ash", beddingFinish: "fabric.red" } },
        { name: "Bare mattress", values: { width: 1.4, length: 2.0, deckHeight: 0.3, frame: "legs", legStyle: "square", railHeight: 0.1, headboard: "none", footboard: false, mattress: 0.26, topper: false, bedding: "none", frameFinish: "metal.black" } },
    ],
    nodes: [
        // ===== A sleeping deck, built with its slat tops at y = 0: rails, slats, mattress, bedding.
        { id: "sideRails", type: "mesh.box", output: false, repeat: 2, size: ["=rt", "=rh", "=L"], radius: 0.003, at: ["=(index * 2 - 1) * (W / 2 + rt / 2)", "=-rh / 2 + 0.03", 0], region: "frame" },
        { id: "endRails", type: "mesh.box", output: false, repeat: 2, size: ["=FW", "=rh", "=rt"], radius: 0.003, at: [0, "=-rh / 2 + 0.03", "=(index * 2 - 1) * (L / 2 + rt / 2)"], region: "frame" },
        { id: "slats", type: "mesh.box", output: false, repeat: "=nSlats", size: ["=W", "=slatT", "=L / nSlats * 0.55"], radius: 0.002, at: [0, "=-slatT / 2", "=-L / 2 + (index + 0.5) * L / nSlats"], region: "frame" },
        { id: "mattressBox", type: "mesh.box", output: false, size: ["=W - 0.01", "=mattress", "=L - 0.01"], radius: "=min(0.05, mattress * 0.3)", segments: 4, at: [0, "=mattress / 2", 0], region: "=bedding == 'none' ? 'mattress' : 'sheets'" },
        { id: "topperBox", type: "mesh.box", output: false, when: "=topper", size: ["=W - 0.03", "=tt", "=L - 0.03"], radius: "=tt * 0.45", segments: 3, at: [0, "=mattress + tt / 2", 0], region: "=bedding == 'none' ? 'mattress' : 'sheets'" },
        // A piped seam round the bare mattress.
        { id: "piping", type: "mesh.box", output: false, when: "=bedding == 'none'", repeat: 2, size: ["=W - 0.006", 0.008, "=L - 0.006"], radius: 0.004, at: [0, "=index == 0 ? 0.03 : mattress - 0.03", 0], region: "mattress" },
        { id: "duvetTop", type: "mesh.box", output: false, when: "=bedding == 'duvet'", size: ["=W + 0.06", "=dt", "=coverL"], radius: "=dt * 0.48", segments: 3, at: [0, "=mTop + dt / 2", "=L / 2 - coverL / 2 + 0.03"], region: "duvet" },
        { id: "duvetSides", type: "mesh.box", output: false, when: "=bedding == 'duvet'", repeat: 2, size: ["=dt * 0.6", "=drop", "=coverL"], radius: "=dt * 0.28", segments: 2, at: ["=(index * 2 - 1) * (W / 2 + 0.03)", "=mTop + dt * 0.5 - drop / 2", "=L / 2 - coverL / 2 + 0.03"], region: "duvet" },
        { id: "duvetFoot", type: "mesh.box", output: false, when: "=bedding == 'duvet'", size: ["=W + 0.06", "=drop", "=dt * 0.6"], radius: "=dt * 0.28", segments: 2, at: [0, "=mTop + dt * 0.5 - drop / 2", "=L / 2 + 0.03"], region: "duvet" },
        // The turned-down fold: a soft roll of duvet with the sheet showing.
        { id: "duvetFold", type: "mesh.cylinder", output: false, when: "=bedding == 'duvet'", radius: "=dt * 1.1", height: "=W + 0.08", segments: 18, bevel: "=dt * 0.6", rotate: [0, 0, -90], at: ["=-(W + 0.08) / 2", "=mTop + dt * 1.1", "=L / 2 - coverL + 0.04"], region: "duvet" },
        {
            id: "pillowBoxes", type: "mesh.box", output: false, when: "=bedding != 'none'", repeat: "=pillows", size: ["=min(0.66, (W - 0.08) / (pillows > 2 ? ceil(pillows / 2) : pillows)) - 0.03", 0.12, 0.42], radius: 0.055, segments: 4, region: "sheets",
            rotate: ["=index >= 2 ? -38 : -6", "=randRange(index * 5 + 1, -4, 4)", 0],
            at: [
                "=(pillows == 1 ? 0 : (index % 2 * 2 - 1) * W / 4)",
                "=mTop + (index >= 2 ? 0.17 : 0.07)",
                "=-L / 2 + (index >= 2 ? 0.12 : 0.32)",
            ],
        },
        { id: "deck", type: "geo.join", output: false, meshes: ["@sideRails", "@endRails", "@slats", "@mattressBox", "@topperBox", "@piping", "@duvetTop", "@duvetSides", "@duvetFoot", "@duvetFold", "@pillowBoxes"] },
        { id: "lowerDeck", type: "geo.transform", mesh: "@deck", at: [0, "=y0", 0] },
        { id: "upperDeck", type: "geo.transform", when: "=isBunk", mesh: "@deck", at: [0, "=upperY", 0] },
        // ===== Supports ============================================================================
        {
            id: "legs", type: "object", object: "component.leg", when: "=frame == 'legs' && !isBunk", repeat: "=W > 1.2 ? 6 : 4", region: "frame",
            params: { height: "=y0 - rh + 0.04", thickness: "=post * 0.8", style: "=legStyle", taper: 0.65 },
            at: ["=index < 4 ? (index % 2 * 2 - 1) * (W / 2 + rt / 2) : 0", 0, "=((index < 4 ? floor(index / 2) : index - 4) * 2 - 1) * (L / 2 + rt / 2)"],
        },
        // A panelled box down to the floor, its front recessed for the toes; or a low plinth.
        { id: "panelBox", type: "mesh.box", when: "=frame == 'panel'", size: ["=FW - 0.012", "=y0 - rh + 0.04", "=FL - 0.012"], at: [0, "=(y0 - rh + 0.04) / 2", 0], region: "frame" },
        { id: "platformBox", type: "mesh.box", when: "=frame == 'platform'", size: ["=FW - 0.1", "=y0 * 0.6", "=FL - 0.1"], at: [0, "=y0 * 0.3", 0], region: "frame" },
        { id: "platformTop", type: "mesh.box", when: "=frame == 'platform'", size: ["=FW + 0.04", "=y0 * 0.4 + 0.03", "=FL + 0.04"], radius: 0.006, at: [0, "=y0 * 0.8 - 0.015", 0], region: "frame" },
        // Bunk: four tall posts carry both decks; a guard rail and a ladder on the open side.
        { id: "bunkPosts", type: "mesh.box", when: "=isBunk", repeat: 4, size: ["=post", "=headTop", "=post"], radius: 0.006, at: ["=(index % 2 * 2 - 1) * (W / 2 + rt / 2)", "=headTop / 2", "=(floor(index / 2) * 2 - 1) * (L / 2 + rt / 2)"], region: "frame" },
        { id: "guardRail", type: "mesh.box", when: "=isBunk", repeat: 2, size: ["=rt * 0.8", 0.05, "=L * 0.68"], radius: 0.004, at: ["=W / 2 + rt / 2", "=upperY + mTop + (index == 0 ? 0.12 : 0.32)", "=-L / 2 + L * 0.34"], region: "frame" },
        { id: "guardPosts", type: "mesh.box", when: "=isBunk", size: ["=rt * 0.8", 0.4, 0.05], at: ["=W / 2 + rt / 2", "=upperY + 0.2 + 0.03", "=-L / 2 + L * 0.68"], region: "frame" },
        { id: "ladderRails", type: "mesh.box", when: "=isBunk", repeat: 2, size: [0.04, "=upperY + 0.35", 0.05], radius: 0.004, rotate: [0, 0, -8], at: ["=W / 2 + rt + 0.08", "=(upperY + 0.35) / 2", "=L / 2 - 0.1 - index * 0.38"], region: "frame" },
        { id: "ladderRungs", type: "mesh.cylinder", when: "=isBunk", repeat: "=floor((upperY + 0.2) / 0.27)", radius: 0.016, height: 0.4, segments: 12, rotate: [90, 0, 0], at: ["=W / 2 + rt + 0.08 + (upperY + 0.35) / 2 * tan(rad(8)) - (0.25 + index * 0.27) * tan(rad(8))", "=0.25 + index * 0.27", "=L / 2 - 0.1 - 0.38 - 0.01"], region: "frame" },
        // ===== Headboard and footboard ==============================================================
        // Posts at each end, and an infill between them.
        { id: "headPosts", type: "mesh.box", when: "=hasHead && !isBunk && headboard != 'upholstered'", repeat: 2, size: ["=post", "=headTop", "=post"], radius: 0.006, at: ["=(index * 2 - 1) * (FW / 2 - post / 2 + 0.01)", "=headTop / 2", "=-FL / 2 - post / 2 + rt"], region: "frame" },
        { id: "footPosts", type: "mesh.box", when: "=footboard && !isBunk", repeat: 2, size: ["=post", "=footTop", "=post"], radius: 0.006, at: ["=(index * 2 - 1) * (FW / 2 - post / 2 + 0.01)", "=footTop / 2", "=FL / 2 + post / 2 - rt"], region: "frame" },
        { id: "endPanel", type: "mesh.box", output: false, size: ["=FW - 0.01", 1, 0.03], radius: 0.006 },
        { id: "headPanel", type: "geo.transform", when: "=headboard == 'panel' || (isBunk && headboard != 'spindles')", repeat: "=isBunk ? 2 : 1", mesh: "@endPanel", scale: [1, "=isBunk ? 0.32 : headTop - y0 - 0.05", 1], at: [0, "=isBunk ? (index == 0 ? y0 + mTop + 0.2 : upperY + mTop + 0.22) : (headTop + y0 + 0.05) / 2 - 0.04", "=-FL / 2 + rt - 0.02"], region: "headboard" },
        { id: "footPanel", type: "geo.transform", when: "=hasFoot", repeat: "=isBunk ? 2 : 1", mesh: "@endPanel", scale: [1, "=isBunk ? 0.32 : footTop - y0 + 0.02", 1], at: [0, "=isBunk ? (index == 0 ? y0 + mTop + 0.2 : upperY + mTop + 0.22) : (footTop + y0 + 0.02) / 2 - 0.03", "=FL / 2 - rt + 0.02"], region: "frame" },
        { id: "headCap", type: "mesh.box", when: "=headboard == 'panel' || headboard == 'spindles'", size: ["=FW + 0.05", 0.04, 0.07], radius: 0.01, at: [0, "=headTop - 0.02", "=-FL / 2 + rt - 0.02"], region: "frame" },
        { id: "spindleRail", type: "mesh.box", when: "=headboard == 'spindles'", size: ["=FW", 0.06, 0.04], radius: 0.006, at: [0, "=y0 + 0.08", "=-FL / 2 + rt - 0.02"], region: "frame" },
        { id: "spindles", type: "mesh.cylinder", when: "=headboard == 'spindles'", repeat: "=clamp(round(FW / 0.12), 5, 20)", radius: 0.012, height: "=headTop - y0 - 0.12", segments: 12, at: ["=-FW / 2 + post + (index + 0.5) * (FW - 2 * post) / count", "=y0 + 0.1", "=-FL / 2 + rt - 0.02"], region: "frame" },
        // Padded: a deep upholstered slab standing behind the mattress, with optional buttons.
        { id: "pad", type: "mesh.box", when: "=headboard == 'upholstered' && !isBunk", size: ["=FW + 0.06", "=headTop - 0.04", 0.1], radius: 0.045, segments: 4, at: [0, "=(headTop - 0.04) / 2 + 0.04", "=-FL / 2 - 0.03"], region: "headboard" },
        { id: "padFeet", type: "mesh.box", when: "=headboard == 'upholstered' && !isBunk", repeat: 2, size: [0.05, 0.05, 0.06], at: ["=(index * 2 - 1) * (FW / 2 - 0.05)", 0.025, "=-FL / 2 - 0.03"], region: "frame" },
        {
            id: "tufts", type: "mesh.sphere", when: "=headboard == 'upholstered' && tufted && !isBunk", repeat: "=tuftRows * tuftCols", radius: 0.011, segments: 8, rings: 4, scale: [1, 1, 0.5], region: "headboard",
            at: ["=-W / 2 + ((index % tuftCols) + 0.5 + (floor(index / tuftCols) % 2) * 0.5 - 0.25) * W / tuftCols", "=y0 + mTop + 0.12 + floor(index / tuftCols) * 0.16", "=-FL / 2 + 0.02"],
        },
        // ===== Under-bed drawers on the +X side ===================================================
        { id: "drawerFront", type: "mesh.box", output: false, size: [0.02, "=y0 - rh - 0.02", "=dw"], radius: 0.003, at: [0.01, "=(y0 - rh - 0.02) / 2", 0], region: "frame" },
        { id: "drawerBin", type: "mesh.box", output: false, size: ["=W * 0.55", "=y0 - rh - 0.06", "=dw - 0.04"], at: ["=-W * 0.275", "=(y0 - rh - 0.06) / 2 + 0.01", 0], region: "frame" },
        { id: "drawerPull", type: "object", object: "component.handle", output: false, params: { style: "cup", length: 0.1 }, rotate: [0, 90, 0], at: [0.02, "=(y0 - rh) * 0.55", 0], region: "handles" },
        { id: "drawerUnit", type: "geo.join", output: false, meshes: ["@drawerFront", "@drawerBin", "@drawerPull"] },
        { id: "drawers", type: "geo.transform", when: "=storage && frame == 'panel' && !isBunk && y0 - rh > 0.12", repeat: "=nDrawers", mesh: "@drawerUnit", at: ["=FW / 2 - 0.006 + dOpen * (1 - index * 0.35)", 0.01, "=-L / 2 + 0.05 + (index + 0.5) * (dw + 0.01)"] },
    ],
    limits: { maxSize: 2.8, minSize: 0.6, maxTriangles: 80000 },
};

export default bed;
