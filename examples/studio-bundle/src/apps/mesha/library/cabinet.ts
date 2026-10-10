import type { ObjectDef } from "../mesha_object";

/**
 * A rectangular carcass cabinet: bays of hinged doors, drawers that really slide out of their
 * openings, a drawer over doors, or open shelving. Fronts face +Z and overlay the carcass; doors
 * pivot on their outer front corner so an open leaf never sweeps into its neighbour. Handles
 * compose component.handle, legs component.leg.
 */
const cabinet: ObjectDef = {
    id: "furniture.cabinet",
    name: "Cabinet",
    category: "Furniture",
    tags: ["cabinet", "cupboard", "drawers", "chest of drawers", "dresser", "bedside table", "nightstand", "kitchen cabinet", "sideboard", "credenza", "display cabinet", "storage"],
    description: "Doors, drawers or open bays in a carcass on a plinth, legs or feet, with an optional worktop.",
    featured: ["width", "height", "depth", "bays", "layout", "drawers", "frontStyle", "handleStyle", "open", "frontFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "layout", label: "Layout" },
        { id: "fronts", label: "Fronts" },
        { id: "base", label: "Base and top" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "width", label: "Width", type: "number", default: 0.8, min: 0.3, max: 2.4, unit: "m", group: "size" },
        { id: "height", label: "Height", type: "number", default: 0.86, min: 0.3, max: 2.3, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 0.5, min: 0.25, max: 0.75, unit: "m", group: "size" },
        { id: "bays", label: "Bays", type: "int", default: 2, min: 1, max: "=clamp(floor(width / 0.24), 1, 4)", group: "layout", description: "Side-by-side sections, each with its own doors or drawers." },
        { id: "layout", label: "Layout", type: "enum", default: "drawerDoors", options: ["doors", "drawers", "drawerDoors", "open"], optionLabels: ["Doors", "Drawers", "Drawer over doors", "Open shelves"], group: "layout" },
        { id: "drawers", label: "Drawers per bay", type: "int", default: 3, min: 1, max: "=clamp(floor(bodyH / 0.09), 1, 8)", group: "layout", visibleIf: "=layout == 'drawers'" },
        { id: "shelves", label: "Shelves", type: "int", default: 1, min: 0, max: 6, group: "layout", visibleIf: "=layout != 'drawers'" },
        { id: "open", label: "Open", type: "number", default: 0, min: 0, max: 1, group: "layout", variation: 0.4, description: "Swings the doors and slides the drawers out (the top drawer furthest)." },
        { id: "frontStyle", label: "Front style", type: "enum", default: "shaker", options: ["slab", "shaker", "glazed"], optionLabels: ["Slab", "Shaker", "Glazed doors"], group: "fronts", visibleIf: "=layout != 'open'" },
        { id: "glazingBars", label: "Glazing bars", type: "bool", default: true, group: "fronts", visibleIf: "=frontStyle == 'glazed' && hasDoors" },
        { id: "handleStyle", label: "Handles", type: "enum", default: "bar", options: ["bar", "bow", "knob", "cup", "ring", "tab", "none"], optionLabels: ["Bar", "Bow", "Knob", "Cup", "Ring", "Edge tab", "Push to open"], group: "fronts", visibleIf: "=layout != 'open'" },
        { id: "handleLength", label: "Handle size", type: "number", default: 0.16, min: 0.04, max: 0.5, unit: "m", decimals: 3, group: "fronts", visibleIf: "=layout != 'open' && handleStyle != 'none'" },
        { id: "base", label: "Base", type: "enum", default: "plinth", options: ["plinth", "legs", "feet", "none"], optionLabels: ["Plinth", "Legs", "Bun feet", "None"], group: "base" },
        { id: "baseHeight", label: "Base height", type: "number", default: 0.1, min: 0.02, max: "=min(0.4, height * 0.45)", unit: "m", group: "base", visibleIf: "=base != 'none'" },
        { id: "legStyle", label: "Leg style", type: "enum", default: "tapered", options: ["square", "tapered", "round", "turned"], optionLabels: ["Square", "Tapered", "Round", "Turned"], group: "base", visibleIf: "=base == 'legs'" },
        { id: "worktop", label: "Worktop", type: "bool", default: false, group: "base" },
        { id: "worktopThickness", label: "Worktop thickness", type: "number", default: 0.03, min: 0.012, max: 0.06, unit: "m", decimals: 3, group: "base", visibleIf: "=worktop" },
        { id: "overhang", label: "Worktop overhang", type: "number", default: 0.025, min: 0, max: 0.3, unit: "m", decimals: 3, group: "base", visibleIf: "=worktop", description: "Past the fronts; a deep overhang makes a breakfast bar." },
        { id: "carcassFinish", label: "Carcass", type: "material", default: "paint.white", materials: ["wood", "paint", "metal.steel", "metal.black", "plastic.white", "plastic.grey"], group: "materials" },
        { id: "frontFinish", label: "Fronts", type: "material", default: "paint.sage", materials: ["wood", "paint", "metal.steel", "metal.black", "plastic"], group: "materials" },
        { id: "handleFinish", label: "Handles", type: "material", default: "metal.brass", materials: ["metal", "wood", "leather.tan", "leather.black", "plastic.black", "ceramic.white"], group: "materials", visibleIf: "=layout != 'open' && handleStyle != 'none'" },
        { id: "baseFinish", label: "Legs / feet", type: "material", default: "wood.oak", materials: ["wood", "paint", "metal"], group: "materials", visibleIf: "=base == 'legs' || base == 'feet'" },
        { id: "worktopFinish", label: "Worktop", type: "material", default: "stone.marble", materials: ["stone", "wood", "metal.steel", "masonry.concrete"], group: "materials", visibleIf: "=worktop" },
        { id: "glassFinish", label: "Glass", type: "material", default: "glass.window", materials: ["glass.window", "glass.windowTinted", "glass.frosted", "glass.clear"], group: "materials", visibleIf: "=frontStyle == 'glazed' && hasDoors" },
        { id: "seed", label: "Seed", type: "seed", default: 3, group: "materials", variation: 0 },
    ],
    derived: {
        pt: "=clamp(width * 0.022, 0.016, 0.024)",
        ft: 0.019,
        gap: 0.003,
        bt: 0.006,
        wt: "=worktop ? worktopThickness : 0",
        y0: "=base == 'none' ? 0 : baseHeight",
        y1: "=height - wt",
        bodyH: "=y1 - y0",
        cd: "=depth - ft",
        cz: "=-ft / 2",
        bayW: "=width / bays",
        hasDoors: "=layout == 'doors' || layout == 'drawerDoors'",
        nDr: "=layout == 'drawers' ? drawers : layout == 'drawerDoors' ? 1 : 0",
        dh: "=layout == 'drawers' ? bodyH / drawers : clamp(bodyH * 0.22, 0.1, 0.2)",
        doorTop: "=layout == 'drawerDoors' ? y1 - dh : y1",
        doorH: "=doorTop - y0 - gap",
        leaves: "=hasDoors && bayW > 0.62 ? 2 : 1",
        lw: "=bayW / leaves - gap",
        fw: "=bayW - gap",
        fh: "=dh - gap",
        // Drawer boxes: clear of the side panels and dividers, behind the front, short of the back.
        st: 0.012,
        boxW: "=bayW - 1.5 * pt - 0.026",
        boxD: "=cd - bt - 0.03",
        boxH: "=max(0.03, fh - pt - 0.03)",
        slide: "=open * boxD * 0.75",
        angle: "=open * 95",
        // Frame-and-panel stiles and rails.
        sw: "=min(0.065, lw * 0.2, doorH * 0.2)",
        dsw: "=min(0.05, fh * 0.22, fw * 0.2)",
        shaped: "=frontStyle != 'slab'",
        vertHandle: "=handleStyle == 'bar' || handleStyle == 'bow'",
        drawerHl: "=min(handleLength, fw * 0.6)",
        doorHl: "=vertHandle ? min(handleLength, doorH * 0.6) : min(handleLength, lw * 0.6)",
        // Door pulls sit near the free edge: at hand height on a tall door, near the top on a low one.
        doorHx: "=handleStyle == 'tab' ? lw / 2 : lw - (vertHandle ? 0.04 : handleStyle == 'cup' ? 0.03 + doorHl / 2 : 0.045)",
        doorHy: "=handleStyle == 'tab' ? doorH : doorTop > 1.3 ? clamp(1.05 - y0, doorHl / 2 + 0.05, doorH - doorHl / 2 - 0.05) : doorH - 0.06 - (vertHandle ? doorHl / 2 : handleStyle == 'ring' ? 0 : 0.01)",
        lt: "=clamp(min(width, depth) * 0.08, 0.03, 0.06)",
        footR: "=clamp(baseHeight * 0.6, 0.02, 0.045)",
        shelfSpan: "=doorTop - y0 - pt - (layout == 'drawerDoors' ? pt : 0)",
        nBars: "=glazingBars ? max(0, round(doorH / 0.32) - 1) : 0",
    },
    rules: [
        { check: "=nDr == 0 || fh >= 0.075", message: "The drawers are too shallow: fewer drawers or a taller cabinet." },
        { check: "=nDr == 0 || boxD >= 0.15", message: "Too shallow for drawers to run." },
        { check: "=!hasDoors || lw >= 0.16", message: "The door leaves are too narrow: fewer bays." },
        { check: "=layout == 'drawers' || shelves == 0 || shelfSpan / (shelves + 1) >= 0.12", message: "The shelves are too close together to hold anything." },
        { check: "=height / min(width, depth) < 5.5", message: "Too tall and narrow to stand safely." },
        { check: "=bodyH > 0.15", message: "The base and worktop leave no room for the cabinet." },
    ],
    regions: {
        carcass: { label: "Carcass", material: "=carcassFinish" },
        fronts: { label: "Fronts", material: "=frontFinish" },
        handles: { label: "Handles", material: "=handleFinish" },
        base: { label: "Base", material: "=base == 'plinth' ? carcassFinish : baseFinish" },
        worktop: { label: "Worktop", material: "=worktopFinish" },
        glass: { label: "Glass", material: "=glassFinish" },
    },
    presets: [
        { name: "Bedside table", values: { width: 0.48, height: 0.6, depth: 0.4, bays: 1, layout: "drawers", drawers: 2, frontStyle: "slab", handleStyle: "knob", handleLength: 0.12, base: "legs", baseHeight: 0.18, legStyle: "tapered", carcassFinish: "wood.walnut", frontFinish: "wood.walnut", baseFinish: "wood.walnut", handleFinish: "metal.brass" } },
        { name: "Kitchen base unit", values: { width: 0.8, height: 0.9, depth: 0.6, bays: 1, layout: "drawerDoors", shelves: 1, frontStyle: "shaker", handleStyle: "bar", handleLength: 0.16, base: "plinth", baseHeight: 0.1, worktop: true, worktopThickness: 0.03, overhang: 0.025, carcassFinish: "paint.white", frontFinish: "paint.sage", handleFinish: "metal.brass", worktopFinish: "stone.marble" } },
        { name: "Workshop cabinet", values: { width: 0.9, height: 1.8, depth: 0.45, bays: 1, layout: "doors", shelves: 4, frontStyle: "slab", handleStyle: "bow", handleLength: 0.2, base: "plinth", baseHeight: 0.05, carcassFinish: "metal.steel", frontFinish: "paint.navy", handleFinish: "metal.chrome" } },
        { name: "Chest of drawers", values: { width: 1.0, height: 0.95, depth: 0.5, bays: 2, layout: "drawers", drawers: 4, frontStyle: "shaker", handleStyle: "cup", handleLength: 0.09, base: "feet", baseHeight: 0.07, carcassFinish: "wood.oak", frontFinish: "wood.oak", baseFinish: "wood.oak", handleFinish: "metal.black" } },
        { name: "Glazed display", values: { width: 0.9, height: 1.9, depth: 0.4, bays: 1, layout: "drawerDoors", shelves: 4, frontStyle: "glazed", glazingBars: true, handleStyle: "knob", handleLength: 0.1, base: "plinth", baseHeight: 0.08, carcassFinish: "wood.cherry", frontFinish: "wood.cherry", handleFinish: "metal.brass", glassFinish: "glass.window" } },
        { name: "Mid-century sideboard", values: { width: 1.8, height: 0.76, depth: 0.45, bays: 3, layout: "drawerDoors", shelves: 1, frontStyle: "slab", handleStyle: "tab", handleLength: 0.14, base: "legs", baseHeight: 0.2, legStyle: "round", carcassFinish: "wood.walnut", frontFinish: "wood.walnut", baseFinish: "wood.walnut", handleFinish: "metal.brass" } },
    ],
    nodes: [
        // --- Carcass ---------------------------------------------------------------------------
        { id: "sides", type: "mesh.box", repeat: 2, size: ["=pt", "=bodyH - pt", "=cd"], radius: 0.0015, at: ["=(index * 2 - 1) * (width / 2 - pt / 2)", "=y0 + (bodyH - pt) / 2", "=cz"], region: "carcass" },
        { id: "topPanel", type: "mesh.box", size: ["=width", "=pt", "=cd"], radius: "=worktop ? 0.0015 : 0.004", at: [0, "=y1 - pt / 2", "=cz"], region: "carcass" },
        { id: "bottomPanel", type: "mesh.box", size: ["=width - 2 * pt", "=pt", "=cd"], at: [0, "=y0 + pt / 2", "=cz"], region: "carcass" },
        { id: "backPanel", type: "mesh.box", size: ["=width - 2 * pt", "=bodyH - 2 * pt", "=bt"], at: [0, "=y0 + bodyH / 2", "=-depth / 2 + bt / 2"], region: "carcass" },
        { id: "dividers", type: "mesh.box", repeat: "=bays - 1", size: ["=pt", "=bodyH - 2 * pt", "=cd - bt"], radius: 0.001, at: ["=-width / 2 + (index + 1) * bayW", "=y0 + bodyH / 2", "=cz + bt / 2"], region: "carcass" },
        // Under a drawer-over-doors bay, a rail closes the cupboard below.
        { id: "drawerRail", type: "mesh.box", when: "=layout == 'drawerDoors'", size: ["=width - 2 * pt", "=pt", "=cd - bt"], at: [0, "=doorTop - pt / 2", "=cz + bt / 2"], region: "carcass" },
        // Shelves span each bay between its side and divider.
        {
            id: "shelfBoards", type: "mesh.box", when: "=layout != 'drawers'", repeat: "=bays * shelves", region: "carcass", radius: 0.001,
            size: ["=(floor(index / shelves) == bays - 1 ? width / 2 - pt : -width / 2 + (floor(index / shelves) + 1) * bayW - pt / 2) - (floor(index / shelves) == 0 ? -width / 2 + pt : -width / 2 + floor(index / shelves) * bayW + pt / 2) - 0.002", "=pt", "=cd - bt - 0.02"],
            at: [
                "=((floor(index / shelves) == bays - 1 ? width / 2 - pt : -width / 2 + (floor(index / shelves) + 1) * bayW - pt / 2) + (floor(index / shelves) == 0 ? -width / 2 + pt : -width / 2 + floor(index / shelves) * bayW + pt / 2)) / 2",
                "=y0 + pt + (index % shelves + 1) * shelfSpan / (shelves + 1)",
                "=cz + bt / 2 - 0.01",
            ],
        },
        // --- Base and top ----------------------------------------------------------------------
        // A plinth set back for the toes.
        { id: "plinth", type: "mesh.box", when: "=base == 'plinth'", size: ["=width - 0.012", "=baseHeight", "=cd - 0.06"], at: [0, "=baseHeight / 2", "=cz - 0.03"], region: "base" },
        {
            id: "legs", type: "object", object: "component.leg", when: "=base == 'legs'", repeat: "=width > 1.3 ? 6 : 4", region: "base",
            params: { height: "=baseHeight + 0.002", thickness: "=lt", style: "=legStyle", taper: 0.6 },
            at: ["=index < 4 ? (index % 2 * 2 - 1) * (width / 2 - lt / 2 - 0.012) : 0", 0, "=cz + ((index < 4 ? floor(index / 2) : index - 4) * 2 - 1) * (cd / 2 - lt / 2 - 0.012)"],
        },
        {
            id: "feet", type: "mesh.cylinder", when: "=base == 'feet'", repeat: 4, radius: "=footR", height: "=baseHeight + 0.002", segments: 24, bevel: "=min(baseHeight, footR) * 0.45", bevelSegments: 4, region: "base",
            at: ["=(index % 2 * 2 - 1) * (width / 2 - footR - 0.01)", 0, "=cz + (floor(index / 2) * 2 - 1) * (cd / 2 - footR - 0.01)"],
        },
        { id: "worktopSlab", type: "mesh.box", when: "=worktop", size: ["=width + 0.004", "=wt", "=depth + overhang"], radius: "=wt * 0.2", segments: 3, at: [0, "=height - wt / 2", "=overhang / 2"], region: "worktop" },
        // --- A door leaf, built at its hinge: the pivot is the outer front corner (origin), the
        // leaf runs along +X, its back toward -Z. --------------------------------------------------
        { id: "doorSlab", type: "mesh.box", output: false, when: "=!shaped", size: ["=lw", "=doorH", "=ft"], radius: 0.0025, at: ["=lw / 2", "=doorH / 2", "=-ft / 2"], region: "fronts" },
        { id: "doorStiles", type: "mesh.box", output: false, when: "=shaped", repeat: 2, size: ["=sw", "=doorH", "=ft"], radius: 0.002, at: ["=index == 0 ? sw / 2 : lw - sw / 2", "=doorH / 2", "=-ft / 2"], region: "fronts" },
        { id: "doorRails", type: "mesh.box", output: false, when: "=shaped", repeat: 2, size: ["=lw - 2 * sw + 0.002", "=sw", "=ft * 0.96"], radius: 0.002, at: ["=lw / 2", "=index == 0 ? sw / 2 : doorH - sw / 2", "=-ft / 2"], region: "fronts" },
        { id: "doorPanel", type: "mesh.box", output: false, when: "=frontStyle == 'shaker'", size: ["=lw - 2 * sw + 0.006", "=doorH - 2 * sw + 0.006", "=ft * 0.45"], radius: 0.001, at: ["=lw / 2", "=doorH / 2", "=-ft * 0.7"], region: "fronts" },
        { id: "doorGlass", type: "mesh.box", output: false, when: "=frontStyle == 'glazed'", size: ["=lw - 2 * sw + 0.008", "=doorH - 2 * sw + 0.008", 0.004], at: ["=lw / 2", "=doorH / 2", "=-ft * 0.55"], region: "glass" },
        { id: "doorBars", type: "mesh.box", output: false, when: "=frontStyle == 'glazed'", repeat: "=nBars", size: ["=lw - 2 * sw + 0.004", 0.016, "=ft * 0.6"], radius: 0.002, at: ["=lw / 2", "=sw + (index + 1) * (doorH - 2 * sw) / (nBars + 1)", "=-ft * 0.45"], region: "fronts" },
        { id: "doorBarV", type: "mesh.box", output: false, when: "=frontStyle == 'glazed' && glazingBars && lw > 0.32", size: [0.016, "=doorH - 2 * sw + 0.004", "=ft * 0.6"], radius: 0.002, at: ["=lw / 2", "=doorH / 2", "=-ft * 0.45"], region: "fronts" },
        {
            id: "doorPull", type: "object", object: "component.handle", output: false, when: "=handleStyle != 'none'", region: "handles",
            params: { style: "=handleStyle", length: "=doorHl", thickness: "=clamp(doorHl * 0.075, 0.008, 0.016)", projection: 0.032 },
            rotate: [0, 0, "=vertHandle ? 90 : 0"], at: ["=doorHx", "=doorHy", 0],
        },
        { id: "doorUnit", type: "geo.join", output: false, meshes: ["@doorSlab", "@doorStiles", "@doorRails", "@doorPanel", "@doorGlass", "@doorBars", "@doorBarV", "@doorPull"] },
        // Leaves alternate hinge sides (a pair per wide bay meets in the middle); a right-hinged leaf
        // is the left one mirrored. Open swings the free edge out toward +Z.
        {
            id: "doors", type: "geo.transform", when: "=hasDoors", repeat: "=bays * leaves", mesh: "@doorUnit",
            scale: ["=1 - 2 * (index % 2)", 1, 1], rotate: [0, "=-(1 - 2 * (index % 2)) * angle", 0],
            at: ["=-width / 2 + (index + index % 2) * bayW / leaves + (1 - 2 * (index % 2)) * gap / 2", "=y0 + gap / 2", "=depth / 2"],
        },
        // --- A drawer, built at its front: the face at z = 0 centred on x, the bottom edge at y = 0,
        // a dovetailed box behind it. ---------------------------------------------------------------
        { id: "drawerSlab", type: "mesh.box", output: false, when: "=!shaped", size: ["=fw", "=fh", "=ft"], radius: 0.0025, at: [0, "=fh / 2", "=-ft / 2"], region: "fronts" },
        { id: "drawerStiles", type: "mesh.box", output: false, when: "=shaped", repeat: 2, size: ["=dsw", "=fh", "=ft"], radius: 0.002, at: ["=(index * 2 - 1) * (fw / 2 - dsw / 2)", "=fh / 2", "=-ft / 2"], region: "fronts" },
        { id: "drawerRails", type: "mesh.box", output: false, when: "=shaped", repeat: 2, size: ["=fw - 2 * dsw + 0.002", "=dsw", "=ft * 0.96"], radius: 0.002, at: [0, "=index == 0 ? dsw / 2 : fh - dsw / 2", "=-ft / 2"], region: "fronts" },
        { id: "drawerPanel", type: "mesh.box", output: false, when: "=shaped", size: ["=fw - 2 * dsw + 0.006", "=fh - 2 * dsw + 0.006", "=ft * 0.45"], radius: 0.001, at: [0, "=fh / 2", "=-ft * 0.7"], region: "fronts" },
        { id: "drawerSides", type: "mesh.box", output: false, repeat: 2, size: ["=st", "=boxH", "=boxD"], radius: 0.001, at: ["=(index * 2 - 1) * (boxW / 2 - st / 2)", "=pt + 0.012 + boxH / 2", "=-ft - boxD / 2"], region: "carcass" },
        { id: "drawerEnds", type: "mesh.box", output: false, repeat: 2, size: ["=boxW - 2 * st", "=boxH", "=st"], at: [0, "=pt + 0.012 + boxH / 2", "=index == 0 ? -ft - st / 2 : -ft - boxD + st / 2"], region: "carcass" },
        { id: "drawerBottom", type: "mesh.box", output: false, size: ["=boxW - 2 * st", 0.006, "=boxD - 2 * st"], at: [0, "=pt + 0.015", "=-ft - boxD / 2"], region: "carcass" },
        {
            id: "drawerPull", type: "object", object: "component.handle", output: false, when: "=handleStyle != 'none'", region: "handles",
            params: { style: "=handleStyle", length: "=drawerHl", thickness: "=clamp(drawerHl * 0.075, 0.008, 0.016)", projection: 0.032 },
            at: [0, "=handleStyle == 'tab' ? fh : handleStyle == 'ring' ? fh * 0.62 : fh / 2", 0],
        },
        { id: "drawerUnit", type: "geo.join", output: false, meshes: ["@drawerSlab", "@drawerStiles", "@drawerRails", "@drawerPanel", "@drawerSides", "@drawerEnds", "@drawerBottom", "@drawerPull"] },
        // Top to bottom in each bay; open pulls the top drawer furthest and the lower ones less.
        {
            id: "drawerFronts", type: "geo.transform", when: "=nDr > 0", repeat: "=bays * nDr", mesh: "@drawerUnit",
            at: ["=-width / 2 + (floor(index / nDr) + 0.5) * bayW", "=y1 - (index % nDr + 1) * dh + gap / 2", "=depth / 2 + slide * pow(0.55, index % nDr)"],
        },
    ],
    limits: { maxSize: 2.7, minSize: 0.25, maxTriangles: 120000 },
};

export default cabinet;
