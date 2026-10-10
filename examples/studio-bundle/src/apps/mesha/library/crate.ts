import type { ObjectDef } from "../mesha_object";

/**
 * Hollow storage you can put things in: a slatted timber crate on corner posts (a strap-hinged
 * lid, hand slots cut through the end slats, seeded wear), a cardboard carton with four top flaps
 * that fold shut and get taped, or a plastic tote with tapering walls, a stacking rim and real
 * hand holes. Openings are built from the pieces around them, never cut. Faces +Z.
 */
const crate: ObjectDef = {
    id: "household.crate",
    name: "Crate, Carton & Bin",
    category: "Household",
    tags: ["crate", "box", "carton", "cardboard box", "shipping box", "storage bin", "tote", "storage box", "fruit crate", "wooden crate", "container"],
    description: "Timber crate, cardboard carton or plastic tote: hollow, with lids, flaps and hand holes.",
    featured: ["style", "width", "depth", "height", "lid", "open", "handHoles", "wear"],
    groups: [
        { id: "size", label: "Size" },
        { id: "build", label: "Construction" },
        { id: "lid", label: "Lid" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "style", label: "Style", type: "enum", default: "crate", options: ["crate", "carton", "tote"], optionLabels: ["Timber crate", "Cardboard carton", "Plastic tote"], group: "build" },
        { id: "width", label: "Width", type: "number", default: 0.5, min: 0.18, max: 1.2, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 0.35, min: 0.14, max: 0.9, unit: "m", group: "size" },
        { id: "height", label: "Height", type: "number", default: 0.3, min: 0.08, max: 0.8, unit: "m", group: "size" },
        { id: "slats", label: "Slats per side", type: "int", default: 3, min: 2, max: "=clamp(floor(height / 0.045), 2, 8)", group: "build", visibleIf: "=style == 'crate'" },
        { id: "slatThickness", label: "Slat thickness", type: "number", default: 0.014, min: 0.008, max: 0.03, unit: "m", decimals: 3, group: "build", visibleIf: "=style == 'crate'" },
        { id: "taper", label: "Wall taper", type: "number", default: 4, min: 0, max: 10, unit: "°", group: "build", visibleIf: "=style == 'tote'" },
        { id: "handHoles", label: "Hand holes", type: "bool", default: true, group: "build", visibleIf: "=style != 'carton'" },
        { id: "wear", label: "Wear", type: "number", default: 0.2, min: 0, max: 1, group: "build", visibleIf: "=style == 'crate'", description: "Slats knocked askew, and the odd one missing." },
        { id: "lid", label: "Lid", type: "bool", default: false, group: "lid", visibleIf: "=style != 'carton'" },
        { id: "open", label: "Open", type: "number", default: 0.4, min: 0, max: 1, group: "lid", visibleIf: "=style == 'carton' || lid", description: "Lifts the lid on its hinges; folds the carton's flaps out." },
        { id: "tape", label: "Tape", type: "bool", default: true, group: "lid", visibleIf: "=style == 'carton'" },
        { id: "woodFinish", label: "Timber", type: "material", default: "wood.ash", materials: ["wood", "paint"], group: "materials", visibleIf: "=style == 'crate'" },
        { id: "cardFinish", label: "Card", type: "material", default: "paper.cardboard", materials: ["paper.cardboard", "paper.kraft", "paper.white"], group: "materials", visibleIf: "=style == 'carton'" },
        { id: "plasticFinish", label: "Plastic", type: "material", default: "plastic.grey", materials: ["plastic", "glass.frosted"], group: "materials", visibleIf: "=style == 'tote'" },
        { id: "lidFinish", label: "Lid", type: "material", default: "plastic.red", materials: ["plastic", "glass.frosted"], group: "materials", visibleIf: "=style == 'tote' && lid" },
        { id: "seed", label: "Seed", type: "seed", default: 9, group: "materials" },
    ],
    derived: {
        W: "=width",
        D: "=depth",
        H: "=height",
        // --- Crate ---
        st: "=slatThickness",
        cgap: "=clamp(H * 0.05, 0.006, 0.025)",
        sh: "=(H - (slats - 1) * cgap) / slats",
        cp: "=clamp(min(W, D) * 0.1, 0.022, 0.05)",
        nFloor: "=clamp(round(D / 0.09), 2, 10)",
        hw: "=min(0.11, (D - 2 * st) * 0.5)",
        lidA: "=open * 105",
        // A knocked slat tilts no further than its gap allows.
        tilt: "=min(2.5, deg(cgap / W))",
        tiltEnd: "=min(2.5, deg(cgap / D))",
        // --- Carton ---
        ct: 0.004,
        // Open flaps hang outside the walls, never down through the floor.
        flapMax: "=H - 0.006 < D / 2 ? deg(atan2(sqrt(1 - pow((H - 0.006) / (D / 2), 2)), -(H - 0.006) / (D / 2))) : 112",
        flapA: "=lerp(90, -min(112, flapMax), open)",
        // --- Tote ---
        tw: 0.0035,
        ta: "=rad(taper)",
        rim: "=clamp(H * 0.08, 0.012, 0.03)",
        inset: "=(H - rim) * tan(ta)",
        hs: "=(H - rim) / cos(ta)",
        thw: "=min(0.12, (D - 2 * inset) * 0.42)",
        thh: "=clamp(hs * 0.12, 0.02, 0.035)",
        holeY: "=hs - rim - thh - 0.012",
        totes: "=style == 'tote'",
        crates: "=style == 'crate'",
        cartons: "=style == 'carton'",
    },
    rules: [
        { check: "=!crates || sh >= 0.025", message: "The slats are too narrow: fewer slats." },
        { check: "=!handHoles || cartons || (crates ? sh >= 0.045 : holeY > hs * 0.4)", message: "Too shallow for hand holes." },
        { check: "=!totes || inset < min(W, D) * 0.25", message: "The walls taper too steeply for the floor." },
        { check: "=max(W, D) / H < 8", message: "Too flat to be a box: make it a tray." },
    ],
    regions: {
        body: { label: "Body", material: "=crates ? woodFinish : cartons ? cardFinish : plasticFinish" },
        lid: { label: "Lid", material: "=totes ? lidFinish : crates ? woodFinish : cardFinish" },
        tape: { label: "Tape", material: "plastic.tape" },
        hardware: { label: "Hinges", material: "metal.black" },
    },
    presets: [
        { name: "Fruit crate", values: { style: "crate", width: 0.5, depth: 0.32, height: 0.28, slats: 3, slatThickness: 0.012, handHoles: true, wear: 0.35, lid: false, woodFinish: "wood.ash" } },
        { name: "Shipping crate", values: { style: "crate", width: 1.0, depth: 0.7, height: 0.65, slats: 6, slatThickness: 0.022, handHoles: false, wear: 0.15, lid: true, open: 0.55, woodFinish: "wood.weathered" } },
        { name: "Moving carton", values: { style: "carton", width: 0.5, depth: 0.4, height: 0.4, open: 0.75, tape: true, cardFinish: "paper.cardboard" } },
        { name: "Sealed parcel", values: { style: "carton", width: 0.36, depth: 0.26, height: 0.18, open: 0, tape: true, cardFinish: "paper.kraft" } },
        { name: "Storage tote", values: { style: "tote", width: 0.6, depth: 0.4, height: 0.32, taper: 4, handHoles: true, lid: true, open: 0.3, plasticFinish: "plastic.grey", lidFinish: "plastic.red" } },
        { name: "Clear bin", values: { style: "tote", width: 0.4, depth: 0.3, height: 0.22, taper: 6, handHoles: true, lid: false, plasticFinish: "glass.frosted" } },
    ],
    nodes: [
        // ======================= Timber crate =======================================================
        // Long sides (front and back): full-width slats; wear tilts some and loses the odd upper one.
        {
            id: "longSlats", type: "mesh.box", when: "=crates", repeat: "=2 * slats", region: "body", radius: 0.0012,
            keep: "=index % slats == 0 || rand(index, 21) >= wear * 0.18",
            size: ["=W", "=sh", "=st"],
            rotate: [0, 0, "=index % slats == 0 ? 0 : randRange(index * 3 + 1, -1, 1) * wear * tilt"],
            at: ["=randRange(index * 3 + 2, -1, 1) * wear * 0.01", "=index % slats * (sh + cgap) + sh / 2", "=(floor(index / slats) * 2 - 1) * (D / 2 - st / 2)"],
        },
        // Ends: between the sides; the top slat is two pieces either side of a hand slot.
        {
            id: "endSlats", type: "mesh.box", when: "=crates", repeat: "=2 * slats", region: "body", radius: 0.0012,
            keep: "=!(handHoles && index % slats == slats - 1) && (index % slats == 0 || rand(index + 50, 21) >= wear * 0.18)",
            size: ["=st", "=sh", "=D - 2 * st"],
            rotate: ["=index % slats == 0 ? 0 : randRange(index * 3 + 61, -1, 1) * wear * tiltEnd", 0, 0],
            at: ["=(floor(index / slats) * 2 - 1) * (W / 2 - st / 2)", "=index % slats * (sh + cgap) + sh / 2", 0],
        },
        { id: "endGrips", type: "mesh.box", when: "=crates && handHoles", repeat: 4, region: "body", radius: 0.0012, size: ["=st", "=sh", "=(D - 2 * st - hw) / 2"], at: ["=(floor(index / 2) * 2 - 1) * (W / 2 - st / 2)", "=(slats - 1) * (sh + cgap) + sh / 2", "=(index % 2 * 2 - 1) * (hw / 2 + (D - 2 * st - hw) / 4)"] },
        { id: "posts", type: "mesh.box", when: "=crates", repeat: 4, region: "body", size: ["=cp", "=H - 0.002", "=cp"], at: ["=(index % 2 * 2 - 1) * (W / 2 - st - cp / 2)", "=H / 2", "=(floor(index / 2) * 2 - 1) * (D / 2 - st - cp / 2)"] },
        { id: "floorSlats", type: "mesh.box", when: "=crates", repeat: "=nFloor", region: "body", radius: 0.001, size: ["=W - 2 * st", "=st", "=(D - 2 * st) / nFloor - 0.006"], at: [0, "=st / 2", "=-D / 2 + st + (index + 0.5) * (D - 2 * st) / nFloor"] },
        // The lid: battened boards swinging up about strap hinges along the back edge.
        { id: "lidBoards", type: "mesh.box", output: false, repeat: "=nFloor", radius: 0.001, size: ["=W", "=st", "=D / nFloor - 0.004"], at: [0, "=st / 2", "=(index + 0.5) * D / nFloor"], region: "lid" },
        { id: "lidBattens", type: "mesh.box", output: false, repeat: 2, size: ["=cp", "=st", "=D - 2 * st - 0.01"], at: ["=(index * 2 - 1) * (W / 2 - st - cp / 2 - 0.004)", "=-st / 2", "=D / 2"], region: "lid" },
        { id: "crateLid", type: "geo.join", output: false, meshes: ["@lidBoards", "@lidBattens"] },
        // The lid turns about the hinge pin, which sits on the lid's top surface just behind the back.
        { id: "crateLidAtPin", type: "geo.transform", output: false, mesh: "@crateLid", at: [0, "=-st - 0.004", 0.004] },
        { id: "crateLidPlaced", type: "geo.transform", when: "=crates && lid", mesh: "@crateLidAtPin", rotate: ["=-lidA", 0, 0], at: [0, "=H + st + 0.004", "=-D / 2 - 0.004"] },
        {
            id: "lidHinges", type: "object", object: "component.hinge", when: "=crates && lid", repeat: 2, region: "hardware",
            params: { style: "strap", height: "=clamp(W * 0.1, 0.04, 0.08)", leafWidth: "=D * 0.55", knuckles: 3, open: "=90 + lidA" },
            rotate: [0, 0, 90], at: ["=(index * 2 - 1) * W * 0.3", "=H + st + 0.004", "=-D / 2 - 0.004"],
        },
        // ======================= Cardboard carton ===================================================
        { id: "cartonLong", type: "mesh.box", when: "=cartons", repeat: 2, region: "body", size: ["=W", "=H", "=ct"], at: [0, "=H / 2", "=(index * 2 - 1) * (D / 2 - ct / 2)"] },
        { id: "cartonEnds", type: "mesh.box", when: "=cartons", repeat: 2, region: "body", size: ["=ct", "=H", "=D - 2 * ct"], at: ["=(index * 2 - 1) * (W / 2 - ct / 2)", "=H / 2", 0] },
        { id: "cartonFloor", type: "mesh.box", when: "=cartons", region: "body", size: ["=W - 2 * ct", "=ct * 2", "=D - 2 * ct"], at: [0, "=ct", 0] },
        // Flaps hinge on the top edges: closed they fold in flat (the end flaps under the long ones),
        // open they hang out past the walls.
        { id: "longFlap", type: "mesh.box", output: false, size: ["=W - 0.002", "=D / 2 - 0.002", "=ct"], at: [0, "=D / 4", "=-ct / 2"], region: "lid" },
        { id: "endFlap", type: "mesh.box", output: false, size: ["=D - 2 * ct - 0.004", "=min(D / 2, W / 2) - 0.004", "=ct"], at: [0, "=min(D / 2, W / 2) / 2", "=-ct / 2"], region: "lid" },
        { id: "longFlaps", type: "geo.transform", when: "=cartons", repeat: 2, mesh: "@longFlap", rotate: ["=-flapA", "=index * 180", 0], at: [0, "=H", "=(1 - index * 2) * D / 2"] },
        { id: "endFlaps", type: "geo.transform", when: "=cartons", repeat: 2, mesh: "@endFlap", rotate: ["=-min(flapA, 88) - (flapA > 0 ? 0 : 6)", "=90 + index * 180", 0], at: ["=(1 - index * 2) * W / 2", "=H - (flapA > 80 ? ct : 0)", 0] },
        { id: "tapeTop", type: "mesh.box", when: "=cartons && tape && open < 0.03", region: "tape", size: ["=W + 0.004", 0.0008, 0.05], at: [0, "=H + 0.0004", 0] },
        { id: "tapeEnds", type: "mesh.box", when: "=cartons && tape && open < 0.03", repeat: 2, region: "tape", size: [0.0008, "=min(0.08, H * 0.4)", 0.05], at: ["=(index * 2 - 1) * (W / 2 + 0.0004)", "=H - min(0.08, H * 0.4) / 2", 0] },
        { id: "tapeBits", type: "mesh.box", when: "=cartons && tape && open >= 0.03", repeat: 2, region: "tape", size: [0.0008, "=min(0.06, H * 0.35)", 0.05], at: ["=(index * 2 - 1) * (W / 2 + 0.0004)", "=H - min(0.06, H * 0.35) / 2", 0] },
        // ======================= Plastic tote =======================================================
        // A wall stands on its bottom edge in the XY plane; the end walls are built round a hand hole.
        { id: "toteSide", type: "mesh.box", output: false, size: ["=W - inset", "=hs", "=tw"], radius: 0.0012, at: [0, "=hs / 2", "=-tw / 2"], region: "body" },
        { id: "toteRibs", type: "mesh.box", output: false, repeat: "=max(2, round(W / 0.12))", size: [0.006, "=hs * 0.8", 0.006], radius: 0.002, at: ["=(index - (count - 1) / 2) * (W - inset - 0.08) / max(count - 1, 1)", "=hs * 0.45", 0.002], region: "body" },
        { id: "toteSideUnit", type: "geo.join", output: false, meshes: ["@toteSide", "@toteRibs"] },
        { id: "toteEndSolid", type: "mesh.box", output: false, when: "=!handHoles", size: ["=D - inset", "=hs", "=tw"], radius: 0.0012, at: [0, "=hs / 2", "=-tw / 2"], region: "body" },
        { id: "toteEndBelow", type: "mesh.box", output: false, when: "=handHoles", size: ["=D - inset", "=holeY", "=tw"], radius: 0.0012, at: [0, "=holeY / 2", "=-tw / 2"], region: "body" },
        { id: "toteEndAbove", type: "mesh.box", output: false, when: "=handHoles", size: ["=D - inset", "=hs - holeY - thh", "=tw"], radius: 0.0012, at: [0, "=(hs + holeY + thh) / 2", "=-tw / 2"], region: "body" },
        { id: "toteEndCheeks", type: "mesh.box", output: false, when: "=handHoles", repeat: 2, size: ["=(D - inset - thw) / 2", "=thh", "=tw"], at: ["=(index * 2 - 1) * (thw / 2 + (D - inset - thw) / 4)", "=holeY + thh / 2", "=-tw / 2"], region: "body" },
        { id: "toteGripLip", type: "mesh.box", output: false, when: "=handHoles", size: ["=thw + 0.012", 0.006, 0.014], radius: 0.002, at: [0, "=holeY + thh + 0.003", -0.007], region: "body" },
        { id: "toteEndUnit", type: "geo.join", output: false, meshes: ["@toteEndSolid", "@toteEndBelow", "@toteEndAbove", "@toteEndCheeks", "@toteGripLip"] },
        // Each wall leans out by the taper from the floor's edge.
        { id: "toteSides", type: "geo.transform", when: "=totes", repeat: 2, mesh: "@toteSideUnit", rotate: ["=taper", "=index * 180", 0], at: [0, 0, "=(1 - index * 2) * (D / 2 - inset)"] },
        { id: "toteEnds", type: "geo.transform", when: "=totes", repeat: 2, mesh: "@toteEndUnit", rotate: ["=taper", "=90 + index * 180", 0], at: ["=(1 - index * 2) * (W / 2 - inset)", 0, 0] },
        { id: "toteFloor", type: "mesh.box", when: "=totes", region: "body", size: ["=W - 2 * inset", 0.004, "=D - 2 * inset"], radius: 0.0015, at: [0, 0.002, 0] },
        // A stacking rim round the top: a flange the next box sits on.
        { id: "rimLong", type: "mesh.box", when: "=totes", repeat: 2, region: "body", size: ["=W + 0.012", "=rim", 0.012], radius: 0.003, at: [0, "=H - rim / 2", "=(index * 2 - 1) * (D / 2 - 0.0)"] },
        { id: "rimEnds", type: "mesh.box", when: "=totes", repeat: 2, region: "body", size: [0.012, "=rim", "=D + 0.012"], radius: 0.003, at: ["=(index * 2 - 1) * (W / 2 - 0.0)", "=H - rim / 2", 0] },
        // A snap lid: a stiffened panel with a skirt, hinged along the back.
        { id: "toteLidPanel", type: "mesh.box", output: false, size: ["=W + 0.02", 0.008, "=D + 0.02"], radius: 0.004, at: [0, 0.004, "=D / 2 + 0.006"], region: "lid" },
        { id: "toteLidRaise", type: "mesh.box", output: false, size: ["=W * 0.8", 0.006, "=D * 0.75"], radius: 0.01, at: [0, 0.009, "=D / 2 + 0.006"], region: "lid" },
        { id: "toteLidSkirt", type: "mesh.box", output: false, repeat: 2, size: ["=W + 0.02", 0.018, 0.004], radius: 0.0015, at: [0, -0.005, "=index == 0 ? D + 0.014 : -0.002"], region: "lid" },
        { id: "toteLid", type: "geo.join", output: false, meshes: ["@toteLidPanel", "@toteLidRaise", "@toteLidSkirt"] },
        { id: "toteLidPlaced", type: "geo.transform", when: "=totes && lid", mesh: "@toteLid", rotate: ["=-lidA", 0, 0], at: [0, "=H + 0.0005", "=-D / 2 - 0.006"] },
    ],
    limits: { maxSize: 1.6, minSize: 0.08, maxTriangles: 40000 },
};

export default crate;
