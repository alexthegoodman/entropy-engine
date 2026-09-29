import type { ObjectDef } from "../mesha_object";

// A salvaged steel-portal warehouse after the end of the world. Gable end (roller door) at +Z,
// bays along Z, span across X:
//
//        +------------------------------+   Portal frames at every bay line; purlins carry
//        | offices under the mezzanine  |   corrugated sheets (some missing, some patched).
//        |==== mezzanine edge ==========|   A concrete plinth wall runs round the base, with
//        |S                             |   clerestory strip windows above it (broken, some
//        |S  open floor                 |   boarded). A steel stair S climbs the left wall to a
//        |S                             |   mezzanine along the back, over a row of offices.
//        +-------[ roller door ]---[d]--+   Outside: sandbags, hedgehogs, tyres, razor wire,
//                                           a watchtower at the front-left corner.
//
// Walls use the house's conventions: rotate [-90, 0, 0] runs an outline's (u, v) along (+X, up)
// with its thickness toward -Z; rotate [-90, -90, 0] runs (u, v) along (+Z, up), thickness toward
// +X. Per-copy damage (missing sheets, broken panes, boarded windows, patches) comes from `keep`
// and `rand(index, salt)`, so the same seed always wrecks the same sheets.

/** An I-section centred on the origin: depth along X, flange width along Z. */
const iSection = (d: string, b: string, tf: string, tw: string): [string, string][] => [
    [`=-(${d}) / 2`, `=-(${b}) / 2`], [`=-(${d}) / 2 + ${tf}`, `=-(${b}) / 2`], [`=-(${d}) / 2 + ${tf}`, `=-(${tw}) / 2`], [`=(${d}) / 2 - ${tf}`, `=-(${tw}) / 2`],
    [`=(${d}) / 2 - ${tf}`, `=-(${b}) / 2`], [`=(${d}) / 2`, `=-(${b}) / 2`], [`=(${d}) / 2`, `=(${b}) / 2`], [`=(${d}) / 2 - ${tf}`, `=(${b}) / 2`],
    [`=(${d}) / 2 - ${tf}`, `=(${tw}) / 2`], [`=-(${d}) / 2 + ${tf}`, `=(${tw}) / 2`], [`=-(${d}) / 2 + ${tf}`, `=(${b}) / 2`], [`=-(${d}) / 2`, `=(${b}) / 2`],
];

export const wastelandDepotDef: ObjectDef = {
    id: "architecture.wasteland_depot",
    name: "Wasteland Depot",
    category: "Architecture",
    tags: ["warehouse", "depot", "factory", "workshop", "garage", "shed", "apocalyptic", "post-apocalyptic", "wasteland", "ruin", "ruined", "abandoned", "scrap", "rust", "fortified", "bunker", "industrial", "building", "interior", "mezzanine"],
    description: "A fortified, half-wrecked steel warehouse: rusted corrugated cladding with missing and patched sheets, broken and boarded windows, a jammed roller door, a mezzanine over offices inside, and a watchtower, sandbags and razor wire outside.",
    featured: ["width", "bays", "eave", "roofDamage", "brokenPanes", "boarded", "rollerOpen", "tower", "barricade", "claddingFinish"],
    groups: [
        { id: "size", label: "Shed" },
        { id: "entry", label: "Doors" },
        { id: "windows", label: "Windows" },
        { id: "damage", label: "Decay" },
        { id: "defence", label: "Fortifications" },
        { id: "inside", label: "Mezzanine and offices" },
        { id: "view", label: "Inspect" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        // --- Shed ---
        { id: "width", label: "Span", type: "number", default: 13, min: 9, max: 22, unit: "m", group: "size" },
        { id: "bays", label: "Bays", type: "int", default: 5, min: 3, max: 8, group: "size" },
        { id: "bayLength", label: "Bay length", type: "number", default: 4.6, min: 3.6, max: 6, unit: "m", group: "size" },
        { id: "eave", label: "Eave height", type: "number", default: 5.6, min: 4.4, max: 8.5, unit: "m", group: "size" },
        { id: "pitch", label: "Roof pitch", type: "number", default: 11, min: 5, max: 22, unit: "deg", group: "size" },
        { id: "plinth", label: "Concrete plinth", type: "number", default: 1.2, min: 0.4, max: 2, unit: "m", group: "size", description: "The block wall under the cladding." },
        // --- Doors ---
        { id: "rollerWidth", label: "Roller door width", type: "number", default: 4.4, min: 2.6, max: "=min(7, width - 4.6)", unit: "m", group: "entry" },
        { id: "rollerHeight", label: "Roller door height", type: "number", default: 4, min: 2.6, max: "=eave - 1.1", unit: "m", group: "entry" },
        { id: "rollerOpen", label: "Roller door open", type: "number", default: 0.55, min: 0, max: 1, group: "entry", description: "How far the curtain is rolled up; the bottom slats are buckled." },
        { id: "doorAngle", label: "Side door open", type: "number", default: 35, min: 0, max: 90, unit: "deg", group: "entry" },
        { id: "sign", label: "Sign board", type: "bool", default: true, group: "entry" },
        // --- Windows ---
        { id: "clerestory", label: "Strip windows", type: "bool", default: true, group: "windows" },
        { id: "windowHeight", label: "Window height", type: "number", default: 0.95, min: 0.6, max: "=min(1.5, eave - plinth - 1.1)", unit: "m", group: "windows", visibleIf: "=clerestory" },
        { id: "brokenPanes", label: "Broken panes", type: "number", default: 0.35, min: 0, max: 1, group: "windows", visibleIf: "=clerestory" },
        { id: "boarded", label: "Boarded up", type: "number", default: 0.3, min: 0, max: 1, group: "windows", visibleIf: "=clerestory", description: "Share of the windows nailed over with planks." },
        // --- Decay ---
        { id: "roofDamage", label: "Missing roof sheets", type: "number", default: 0.25, min: 0, max: 1, group: "damage" },
        { id: "patches", label: "Patched sheets", type: "number", default: 0.4, min: 0, max: 1, group: "damage", description: "Mismatched salvage sheets over the cladding and roof." },
        { id: "skylights", label: "Skylight sheets", type: "bool", default: true, group: "damage" },
        // --- Fortifications ---
        { id: "barricade", label: "Sandbags and hedgehogs", type: "bool", default: true, group: "defence" },
        { id: "razorWire", label: "Razor wire", type: "bool", default: true, group: "defence" },
        { id: "tower", label: "Watchtower", type: "bool", default: true, group: "defence" },
        { id: "towerHeight", label: "Lookout height", type: "number", default: 7.8, min: "=eave + 0.6", max: 14, unit: "m", group: "defence", visibleIf: "=tower" },
        { id: "turbine", label: "Scrap wind turbine", type: "bool", default: true, group: "defence", visibleIf: "=tower" },
        { id: "flue", label: "Stove flue", type: "bool", default: true, group: "defence" },
        // --- Inside ---
        { id: "mezzanine", label: "Mezzanine", type: "bool", default: true, group: "inside" },
        { id: "mezzHeight", label: "Mezzanine height", type: "number", default: 3, min: 2.6, max: "=min(3.6, eave - 1.8)", unit: "m", group: "inside", visibleIf: "=mezzanine" },
        { id: "mezzDepth", label: "Mezzanine depth", type: "number", default: 4.2, min: 3, max: "=max(3, min(7, bays * bayLength - 8))", unit: "m", group: "inside", visibleIf: "=mezzanine" },
        { id: "offices", label: "Offices under it", type: "int", default: 3, min: 0, max: "=min(4, floor((width - 0.6) / 2.6))", group: "inside", visibleIf: "=mezzanine" },
        // --- Inspect ---
        { id: "roofVisible", label: "Show roof", type: "bool", default: true, group: "view", variation: 0, description: "Strip the roof sheets off to look in past the frames." },
        // --- Materials ---
        { id: "claddingFinish", label: "Cladding", type: "material", default: "metal.corrugatedRust", materials: ["metal.corrugated", "metal.corrugatedRust", "metal.corrugatedRed", "metal.corrugatedGreen"], group: "materials" },
        { id: "roofFinish", label: "Roof sheets", type: "material", default: "metal.corrugatedRust", materials: ["metal.corrugated", "metal.corrugatedRust", "metal.corrugatedRed", "metal.corrugatedGreen"], group: "materials" },
        { id: "patchFinish", label: "Patches", type: "material", default: "metal.corrugatedRed", materials: ["metal.corrugated", "metal.corrugatedRust", "metal.corrugatedRed", "metal.corrugatedGreen", "metal.rust", "metal.rustYellow"], group: "materials", visibleIf: "=patches > 0" },
        { id: "frameFinish", label: "Steel frames", type: "material", default: "metal.rustRed", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "metal.black", "paint.black", "paint.teal"], group: "materials" },
        { id: "doorFinish", label: "Doors", type: "material", default: "metal.rustYellow", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "paint.black", "paint.teal", "paint.terracotta"], group: "materials" },
        { id: "plinthFinish", label: "Plinth", type: "material", default: "masonry.darkConcrete", materials: ["masonry", "stone"], group: "materials" },
        { id: "floorFinish", label: "Floor slab", type: "material", default: "masonry.concrete", materials: ["masonry", "stone"], group: "materials" },
        { id: "boardFinish", label: "Boards", type: "material", default: "wood.weathered", materials: ["wood"], group: "materials", visibleIf: "=clerestory && boarded > 0" },
        { id: "glassFinish", label: "Glass", type: "material", default: "glass.frosted", materials: ["glass"], group: "materials" },
        { id: "officeFinish", label: "Office walls", type: "material", default: "wood.weathered", materials: ["wood", "masonry", "paint", "metal.corrugated"], group: "materials", visibleIf: "=mezzanine && offices > 0" },
        { id: "lampFinish", label: "Lamps", type: "material", default: "glow.amber", materials: ["glow"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 13, group: "materials", variation: 0 },
    ],
    derived: {
        W2: "=width / 2", D: "=bays * bayLength", D2: "=bays * bayLength / 2", bay: "=bayLength",
        fl: 0.15, pb: "=plinth", pw: 0.25, cl: 0.05,
        tp: "=tan(rad(pitch))", cp: "=cos(rad(pitch))", ov: 0.35,
        ridge: "=eave + W2 * tp",
        // Portal frames: I-sections of depth bd; the rafters' top flanges sit a purlin (pz) under the sheets.
        bd: "=clamp(width * 0.026, 0.3, 0.55)", pz: 0.16,
        xc: "=W2 - pw - bd / 2 - 0.02",
        colTop: "=eave + (W2 - xc) * tp - pz",
        rafterL: "=xc / cp",
        zFrame0: "=-D2 + 0.3", frameStep: "=(D - 0.6) / bays",
        nPur: "=max(3, ceil(W2 / cp / 1.5) + 1)",
        // Roof sheets: two rows per side per bay.
        xs0: "=W2 + ov", sheetL: "=(W2 + ov) / 2 / cp + 0.1",
        // Strip windows.
        cwin: "=bay - 1.1", wh: "=windowHeight", wy0: "=eave - 0.45 - windowHeight",
        npx: "=max(2, round(cwin / 0.75))", paneW: "=cwin / npx", paneH: "=windowHeight / 2",
        // Doors.
        rW: "=rollerWidth", rH: "=rollerHeight",
        xp: "=W2 - 1.2",
        nSl: "=max(0, round(rollerHeight * (1 - rollerOpen) / 0.1))",
        drumY: "=fl + rollerHeight + 0.35",
        signY: "=min(fl + rollerHeight + 1.25, ridge - 0.9)",
        signW: "=min(rollerWidth + 1.4, width - 3)",
        // Inside.
        hasMezz: "=mezzanine",
        mH: "=mezzHeight", md: "=mezzDepth", zM: "=-D2 + mezzDepth",
        nR: "=ceil((mezzHeight - 0.15) / 0.19)", rR: "=(mezzHeight - 0.15) / nR", go: 0.26,
        run: "=(nR - 1) * go", stW: 0.95,
        xs0st: "=-W2 + pw + bd + 0.12", sx: "=-W2 + pw + bd + 0.12 + stW / 2",
        slopeS: "=atan2(rR, go)",
        railX0: "=-W2 + pw + bd + 0.12 + stW + 0.05", railLen: "=W2 - pw - 0.1 - (-W2 + pw + bd + 0.12 + stW + 0.05)",
        nRailPost: "=max(2, ceil(railLen / 1.3) + 1)",
        nOff: "=mezzanine ? offices : 0",
        ow: "=(width - 2 * pw) / max(1, offices)", offH: "=mezzHeight - 0.2 - 0.15",
        owin: "=min(2.4, (width - 2 * pw) / max(1, offices) - 1.9)",
        nMezzCol: "=max(2, ceil((width - 2 * pw) / 4.5) + 1)",
        // Barricade: courses of sandbags either side of the roller door.
        bz: "=D2 + 3.2", bx0: "=rollerWidth / 2 + 1.1", bx1: "=W2 + 1.4",
        nBag: "=max(1, floor((W2 + 1.4 - rollerWidth / 2 - 1.1) / 0.64))",
        // Watchtower at the front-left corner.
        tS: 2.6, tx: "=-W2 - 2.1", tz: "=D2 - 1.3 - 0.5",
        tP: "=towerHeight", nL: "=max(1, round(towerHeight / 2.6))", lvl: "=towerHeight / max(1, round(towerHeight / 2.6))",
        tIn: "=2.6 / 2 - 0.08",
        brAng: "=deg(atan2(towerHeight / max(1, round(towerHeight / 2.6)), 2.6 - 0.16))",
        brLen: "=hypot(towerHeight / max(1, round(towerHeight / 2.6)), 2.6 - 0.16)",
        roofShown: "=roofVisible",
    },
    rules: [
        { check: "=!mezzanine || zM + run < D2 - 2.5", message: "The mezzanine stair runs into the roller door: shallower mezzanine or more bays." },
        { check: "=!clerestory || wy0 > plinth + 0.3", message: "The strip windows sit down on the plinth." },
        { check: "=!mezzanine || offices == 0 || ow >= 2.5", message: "The offices are narrower than 2.5 m." },
        { check: "=signY + 0.45 < ridge - 0.2 || !sign", message: "The sign doesn't fit under the gable." },
    ],
    regions: {
        cladding: { label: "Cladding", material: "=claddingFinish" },
        roof: { label: "Roof sheets", material: "=roofFinish" },
        patch: { label: "Patches", material: "=patchFinish" },
        skylight: { label: "Skylights", material: "glass.fibreglass" },
        frame: { label: "Steel frames", material: "=frameFinish" },
        plinth: { label: "Plinth", material: "=plinthFinish" },
        floor: { label: "Floor slab", material: "=floorFinish" },
        door: { label: "Roller door", material: "=doorFinish" },
        entry: { label: "Side door", material: "=doorFinish" },
        casing: { label: "Door frame", material: "=frameFinish" },
        sill: { label: "Threshold", material: "=plinthFinish" },
        hardware: { label: "Door hardware", material: "metal.black" },
        glass: { label: "Glass", material: "=glassFinish" },
        boards: { label: "Boards", material: "=boardFinish" },
        sandbags: { label: "Sandbags", material: "fabric.sandbag" },
        tyres: { label: "Tyres", material: "rubber.black" },
        wire: { label: "Razor wire", material: "metal.zinc" },
        sign: { label: "Sign", material: "metal.rustYellow" },
        lights: { label: "Lamps", material: "=lampFinish" },
        deck: { label: "Mezzanine deck", material: "metal.rust" },
        offices: { label: "Office walls", material: "=officeFinish" },
        tarp: { label: "Tarp", material: "fabric.canvas" },
    },
    presets: [
        { name: "Scavenger depot", values: {} },
        { name: "Raider fortress", values: { width: 16, bays: 6, eave: 6.5, rollerOpen: 0.15, roofDamage: 0.4, brokenPanes: 0.6, boarded: 0.75, patches: 0.7, towerHeight: 11, claddingFinish: "metal.corrugatedRust", roofFinish: "metal.corrugatedRust", patchFinish: "metal.rust", frameFinish: "metal.black", doorFinish: "metal.rust", lampFinish: "glow.red" } },
        { name: "Abandoned factory", values: { width: 20, bays: 8, bayLength: 5.5, eave: 8, pitch: 8, plinth: 1.8, rollerWidth: 6, rollerHeight: 5, rollerOpen: 0.9, roofDamage: 0.75, brokenPanes: 0.85, boarded: 0, patches: 0.1, barricade: false, razorWire: false, tower: false, flue: true, offices: 4, mezzDepth: 6, claddingFinish: "metal.corrugatedGreen", roofFinish: "metal.corrugated", frameFinish: "metal.rustYellow", doorFinish: "metal.rustRed", plinthFinish: "masonry.brick", lampFinish: "glow.white" } },
        { name: "Settler workshop", values: { width: 10, bays: 3, bayLength: 4.2, eave: 4.6, pitch: 16, plinth: 0.8, rollerWidth: 3.2, rollerHeight: 3.1, rollerOpen: 1, roofDamage: 0, brokenPanes: 0.1, boarded: 0.1, patches: 0.5, razorWire: false, towerHeight: 6, mezzanine: false, claddingFinish: "metal.corrugatedRed", roofFinish: "metal.corrugatedRust", patchFinish: "metal.corrugated", frameFinish: "metal.rust", doorFinish: "metal.rustRed", plinthFinish: "masonry.fieldstone", floorFinish: "masonry.darkConcrete" } },
        { name: "Irradiated garage", values: { width: 11, bays: 4, bayLength: 4, eave: 5, pitch: 7, rollerWidth: 5, rollerHeight: 3.6, rollerOpen: 0.3, roofDamage: 0.5, patches: 0.2, boarded: 0.5, tower: false, barricade: true, razorWire: true, offices: 2, claddingFinish: "metal.corrugated", roofFinish: "metal.corrugatedGreen", patchFinish: "metal.rustYellow", frameFinish: "metal.rustYellow", doorFinish: "metal.rustYellow", lampFinish: "glow.green", glassFinish: "glass.green" } },
    ],
    nodes: [
        // ================= Slab and plinth =================
        { id: "slab", type: "mesh.box", size: ["=width + 0.3", "=fl", "=D + 0.3"], at: [0, "=fl / 2", 0], region: "floor" },
        { id: "plinthSides", type: "mesh.box", repeat: 2, size: ["=pw", "=pb", "=D"], at: ["=(index == 0 ? -1 : 1) * (W2 - pw / 2)", "=pb / 2", 0], region: "plinth" },
        { id: "plinthBack", type: "mesh.box", size: ["=width - 2 * pw", "=pb", "=pw"], at: [0, "=pb / 2", "=-D2 + pw / 2"], region: "plinth" },
        {
            // Left of the roller door, between it and the side door, right of the side door.
            id: "plinthFront", type: "mesh.box", repeat: 3,
            size: ["=[W2 - rW / 2 - 0.1 - pw, xp - 0.55 - rW / 2 - 0.1, W2 - pw - xp - 0.55][index]", "=pb", "=pw"],
            at: ["=[(-W2 + pw - rW / 2 - 0.1) / 2, (rW / 2 + 0.1 + xp - 0.55) / 2, (xp + 0.55 + W2 - pw) / 2][index]", "=pb / 2", "=D2 - pw / 2"], region: "plinth",
        },

        // ================= Cladding =================
        { id: "bayOutline", type: "curve.rect", output: false, width: "=bay", height: "=eave - pb" },
        { id: "bayOutlineAt", type: "curve.transform", output: false, curve: "@bayOutline", offset: [0, "=pb + (eave - pb) / 2"] },
        { id: "stripHole", type: "curve.rect", output: false, width: "=cwin", height: "=wh" },
        { id: "stripHoleAt", type: "curve.transform", output: false, curve: "@stripHole", offset: [0, "=wy0 + wh / 2"] },
        {
            // index % 2: left or right; floor(index / 2): bay. Some bays are salvage sheets.
            id: "sideCladding", type: "mesh.extrude", repeat: "=2 * bays", outline: "@bayOutlineAt", holes: { if: "=clerestory", then: ["@stripHoleAt"], else: [] },
            height: "=cl", rotate: [-90, -90, 0], at: ["=index % 2 == 0 ? -W2 : W2 - cl", 0, "=-D2 + (floor(index / 2) + 0.5) * bay"],
            region: "=rand(index, 21) < patches * 0.3 ? 'patch' : 'cladding'",
        },
        {
            id: "frontGable", type: "curve.points", output: false, closed: true, points: [
                ["=-W2", "=pb"], ["=-rW / 2 - 0.1", "=pb"], ["=-rW / 2 - 0.1", "=fl + rH + 0.1"], ["=rW / 2 + 0.1", "=fl + rH + 0.1"], ["=rW / 2 + 0.1", "=pb"],
                ["=xp - 0.55", "=pb"], ["=xp - 0.55", "=fl + 2.3"], ["=xp + 0.55", "=fl + 2.3"], ["=xp + 0.55", "=pb"],
                ["=W2", "=pb"], ["=W2", "=eave"], [0, "=ridge"], ["=-W2", "=eave"],
            ],
        },
        { id: "backGable", type: "curve.points", output: false, closed: true, points: [["=-W2", "=pb"], ["=W2", "=pb"], ["=W2", "=eave"], [0, "=ridge"], ["=-W2", "=eave"]] },
        { id: "ventHole", type: "curve.circle", output: false, radius: "=min(0.55, (ridge - eave) * 0.3)", segments: 24, center: [0, "=eave + (ridge - eave) * 0.4"] },
        { id: "gables", type: "mesh.extrude", repeat: 2, outline: { if: "=index == 0", then: "@frontGable", else: "@backGable" }, holes: { if: "=index == 1 && ridge - eave > 0.9", then: ["@ventHole"], else: [] }, height: "=cl", rotate: [-90, 0, 0], at: [0, 0, "=index == 0 ? D2 : -D2 + cl"], region: "cladding" },
        { id: "ventBars", type: "mesh.box", when: "=ridge - eave > 0.9", repeat: 5, size: ["=2 * min(0.55, (ridge - eave) * 0.3)", 0.03, 0.03], rotate: [0, 0, -12], at: [0, "=eave + (ridge - eave) * 0.4 + (index - 2) * min(0.55, (ridge - eave) * 0.3) * 0.38", "=-D2 + 0.03"], region: "frame" },
        // Salvage patches bolted over the cladding.
        {
            id: "wallPatches", type: "mesh.box", repeat: "=4 * bays", keep: "=rand(index, 31) < patches * 0.7",
            size: [0.025, "=0.9 + rand(index, 32) * 0.7", "=0.8 + rand(index, 33) * 1.0"], rotate: ["=(rand(index, 34) - 0.5) * 12", 0, 0],
            at: ["=(index % 2 == 0 ? -1 : 1) * (W2 + 0.02)", "=pb + 0.25 + 0.5 + rand(index, 35) * max(0.01, (clerestory ? wy0 : eave) - pb - 1.6)", "=-D2 + (floor(index / 4) + 0.2 + 0.6 * rand(index, 36)) * bay"], region: "patch",
        },

        // ================= Portal frames =================
        { id: "iProfile", type: "curve.points", output: false, closed: true, points: iSection("bd", "0.2", "0.022", "0.012") },
        { id: "columns", type: "mesh.extrude", repeat: "=2 * (bays + 1)", outline: "@iProfile", height: "=colTop - fl", at: ["=(index % 2 == 0 ? -1 : 1) * xc", "=fl", "=zFrame0 + floor(index / 2) * frameStep"], region: "frame" },
        {
            id: "rafters", type: "mesh.extrude", repeat: "=2 * (bays + 1)", outline: "@iProfile", height: "=rafterL",
            rotate: [0, 0, "=(index % 2 == 0 ? -1 : 1) * (90 - pitch)"],
            at: ["=(index % 2 == 0 ? -1 : 1) * xc", "=colTop - bd / 2 / cp", "=zFrame0 + floor(index / 2) * frameStep"], region: "frame",
        },
        { id: "haunches", type: "mesh.box", repeat: "=2 * (bays + 1)", size: ["=bd * 1.4", "=bd * 1.3", 0.02], at: ["=(index % 2 == 0 ? -1 : 1) * (xc - bd * 0.5)", "=colTop - bd * 0.75", "=zFrame0 + floor(index / 2) * frameStep"], region: "frame" },
        { id: "baseplates", type: "mesh.box", repeat: "=2 * (bays + 1)", size: ["=bd + 0.14", 0.03, 0.34], at: ["=(index % 2 == 0 ? -1 : 1) * xc", "=fl + 0.015", "=zFrame0 + floor(index / 2) * frameStep"], region: "frame" },
        {
            id: "purlins", type: "mesh.box", repeat: "=2 * nPur", size: [0.08, "=pz - 0.01", "=D - 0.1"], rotate: [0, 0, "=(index % 2 == 0 ? 1 : -1) * pitch"],
            at: ["=(index % 2 == 0 ? -1 : 1) * (0.25 + floor(index / 2) * (xc - 0.25) / (nPur - 1))", "=eave + (W2 - (0.25 + floor(index / 2) * (xc - 0.25) / (nPur - 1))) * tp - pz / 2 - 0.005", 0], region: "frame",
        },
        { id: "girts", type: "mesh.box", repeat: 4, size: [0.07, 0.14, "=D - 0.1"], at: ["=(index % 2 == 0 ? -1 : 1) * (W2 - cl - 0.04)", "=index < 2 ? pb + 0.15 : (clerestory ? wy0 - 0.12 : (pb + eave) / 2)", 0], region: "frame" },

        // ================= Roof =================
        {
            // index % 2: side; floor(index / 2) % 2: lower or upper row; floor(index / 4): bay.
            id: "roofSheets", type: "mesh.box", repeat: "=4 * bays", keep: "=roofShown && rand(index, 11) >= roofDamage * 0.7",
            size: ["=sheetL", 0.035, "=bay + 0.04"], rotate: [0, 0, "=(index % 2 == 0 ? 1 : -1) * pitch"],
            at: ["=(index % 2 == 0 ? -1 : 1) * xs0 * (floor(index / 2) % 2 == 0 ? 0.75 : 0.25)", "=eave + (W2 - xs0 * (floor(index / 2) % 2 == 0 ? 0.75 : 0.25)) * tp + 0.018 + (floor(index / 2) % 2) * 0.02", "=-D2 + (floor(index / 4) + 0.5) * bay"],
            region: "=skylights && rand(index, 13) < 0.08 ? 'skylight' : (rand(index, 17) < patches * 0.35 ? 'patch' : 'roof')",
        },
        { id: "ridgeCap", type: "curve.points", output: false, closed: true, points: [[-0.32, "=-0.32 * tp"], [0, 0], [0.32, "=-0.32 * tp"], [0.32, "=-0.32 * tp + 0.04"], [0, 0.04], [-0.32, "=-0.32 * tp + 0.04"]] },
        { id: "ridgeCapping", type: "mesh.extrude", when: "=roofShown", outline: "@ridgeCap", height: "=D + 0.1", rotate: [-90, 0, 0], at: [0, "=ridge + 0.055", "=D2 + 0.05"], region: "frame" },
        { id: "barges", type: "mesh.box", when: "=roofShown", repeat: 4, size: ["=(W2 + ov) / cp", 0.2, 0.04], rotate: [0, 0, "=(index % 2 == 0 ? 1 : -1) * pitch"], at: ["=(index % 2 == 0 ? -1 : 1) * (W2 + ov) / 2", "=eave + (W2 - (W2 + ov) / 2) * tp - 0.02", "=(index < 2 ? 1 : -1) * (D2 + 0.03)"], region: "frame" },
        { id: "gutters", type: "mesh.cylinder", when: "=roofShown", repeat: 2, radius: 0.08, height: "=index == 0 ? D : D * 0.6", segments: 10, rotate: [90, 0, 0], at: ["=(index == 0 ? -1 : 1) * (xs0 + 0.05)", "=eave - ov * tp - 0.06", "=-D2"], region: "frame" },
        // One gutter length hangs loose off the right eave.
        { id: "hangingGutter", type: "mesh.cylinder", when: "=roofShown", radius: 0.08, height: "=min(D * 0.4 + 0.1, 3)", segments: 10, rotate: [114, 0, 0], at: ["=xs0 + 0.05", "=eave - ov * tp - 0.06", "=-D2 + D * 0.6"], region: "frame" },
        { id: "fluePipe", type: "mesh.cylinder", when: "=flue", radius: 0.14, height: "=ridge + 1.6 - fl", segments: 16, at: ["=W2 * 0.45", "=fl", "=-D2 + bay * 1.5"], region: "frame" },
        { id: "flueCap", type: "mesh.cone", when: "=flue", bottomRadius: 0.32, topRadius: 0.02, height: 0.3, segments: 16, at: ["=W2 * 0.45", "=ridge + 1.8", "=-D2 + bay * 1.5"], region: "frame" },
        { id: "flueCapLegs", type: "mesh.box", when: "=flue", repeat: 3, size: [0.02, 0.26, 0.02], at: ["=W2 * 0.45 + 0.1 * cos(rad(index * 120))", "=ridge + 1.67", "=-D2 + bay * 1.5 + 0.1 * sin(rad(index * 120))"], region: "frame" },

        // ================= Strip windows =================
        // A frame in wall-local coordinates (outside +Z, bottom at y = 0); panes are placed per pane so each can break.
        { id: "stripOuter", type: "curve.rect", output: false, width: "=cwin + 0.12", height: "=wh + 0.12" },
        { id: "stripFrame", type: "mesh.extrude", output: false, outline: "@stripOuter", holes: ["@stripHole"], height: 0.1, rotate: [-90, 0, 0], at: [0, "=wh / 2", 0.05] },
        { id: "stripMullions", type: "mesh.box", output: false, repeat: "=npx - 1", size: [0.035, "=wh", 0.05], at: ["=-cwin / 2 + (index + 1) * paneW", "=wh / 2", 0] },
        { id: "stripTransom", type: "mesh.box", output: false, size: ["=cwin", 0.035, 0.05], at: [0, "=wh / 2", 0] },
        { id: "stripUnit", type: "geo.join", output: false, meshes: ["@stripFrame", "@stripMullions", "@stripTransom"] },
        { id: "stripFrames", type: "geo.transform", when: "=clerestory", repeat: "=2 * bays", mesh: "@stripUnit", rotate: [0, "=index % 2 == 0 ? -90 : 90", 0], at: ["=(index % 2 == 0 ? -1 : 1) * (W2 - cl / 2)", "=wy0", "=-D2 + (floor(index / 2) + 0.5) * bay"], region: "frame" },
        {
            // index % 2: side; floor(index / 2) % bays: bay; floor(index / (2 bays)): pane (column + row * npx).
            id: "panes", type: "mesh.box", when: "=clerestory", repeat: "=2 * bays * npx * 2", keep: "=rand(index, 5) >= brokenPanes",
            size: [0.012, "=paneH - 0.03", "=paneW - 0.03"],
            at: ["=(index % 2 == 0 ? -1 : 1) * (W2 - cl / 2)", "=wy0 + (floor(floor(index / (2 * bays)) / npx) + 0.5) * paneH", "=-D2 + (floor(index / 2) % bays + 0.5) * bay - cwin / 2 + (floor(index / (2 * bays)) % npx + 0.5) * paneW"], region: "glass",
        },
        {
            // Three planks over a boarded window: index % 3 plank, floor(index / 3) window (side + 2 * bay).
            id: "boards", type: "mesh.box", when: "=clerestory", repeat: "=2 * bays * 3", keep: "=rand(floor(index / 3), 3) < boarded",
            size: [0.03, 0.2, "=cwin + 0.4"], rotate: ["=[-7, 4, -2][index % 3] + (rand(index, 4) - 0.5) * 4", 0, 0],
            at: ["=(floor(index / 3) % 2 == 0 ? -1 : 1) * (W2 + 0.045)", "=wy0 + wh * (0.2 + 0.3 * (index % 3))", "=-D2 + (floor(floor(index / 3) / 2) + 0.5) * bay"], region: "boards",
        },

        // ================= Roller door and side door =================
        { id: "guideRails", type: "mesh.box", repeat: 2, size: [0.12, "=rH + 0.1", 0.14], at: ["=(index == 0 ? -1 : 1) * (rW / 2 + 0.06)", "=fl + (rH + 0.1) / 2", "=D2 + 0.07"], region: "frame" },
        { id: "drum", type: "mesh.box", size: ["=rW + 0.5", 0.55, 0.6], radius: 0.05, segments: 2, at: [0, "=drumY", "=D2 + 0.3"], region: "door" },
        {
            // Slats from the top down; the lowest few are buckled.
            id: "slats", type: "mesh.box", repeat: "=nSl", size: ["=rW - 0.02", 0.102, 0.035],
            rotate: [0, 0, "=index >= nSl - 4 ? (rand(index, 9) - 0.5) * (4 + (index - nSl + 4) * 2) : 0"],
            at: [0, "=fl + rH - (index + 0.5) * 0.1", "=D2 + 0.09 + (index >= nSl - 4 ? rand(index, 10) * 0.05 : 0)"], region: "door",
        },
        { id: "bottomBar", type: "mesh.box", when: "=nSl > 0", size: ["=rW - 0.02", 0.06, 0.06], rotate: [0, 0, "=(rand(nSl, 12) - 0.5) * 8"], at: [0, "=fl + rH - nSl * 0.1 - 0.02", "=D2 + 0.12"], region: "frame" },
        {
            id: "sideDoor", type: "object", object: "architecture.door",
            params: { width: 0.95, height: 2.12, depth: "=pw", exterior: true, style: "flush", fanlight: 0, openAngle: "=doorAngle", casingWidth: 0.08, frameWidth: 0.05, handle: "lever" },
            at: ["=xp", "=fl", "=D2 - pw / 2"],
        },
        // Caged lamps over both doors.
        { id: "lampArms", type: "mesh.box", repeat: 2, size: [0.05, 0.05, 0.4], at: ["=index == 0 ? -rW / 2 - 0.6 : xp", "=index == 0 ? drumY + 0.2 : fl + 2.7", "=D2 + 0.2"], region: "frame" },
        { id: "lampShades", type: "mesh.cone", repeat: 2, bottomRadius: 0.2, topRadius: 0.06, height: 0.16, segments: 14, at: ["=index == 0 ? -rW / 2 - 0.6 : xp", "=(index == 0 ? drumY + 0.2 : fl + 2.7) - 0.14", "=D2 + 0.38"], region: "frame" },
        { id: "lampBulbs", type: "mesh.sphere", repeat: 2, radius: 0.08, segments: 12, rings: 6, at: ["=index == 0 ? -rW / 2 - 0.6 : xp", "=(index == 0 ? drumY + 0.2 : fl + 2.7) - 0.16", "=D2 + 0.38"], region: "lights" },
        { id: "signBoard", type: "mesh.box", when: "=sign", size: ["=signW", 0.9, 0.06], radius: 0.015, segments: 1, rotate: [0, 0, 3], at: [0, "=signY", "=D2 + 0.08"], region: "sign" },
        { id: "signStripes", type: "mesh.box", when: "=sign", repeat: 2, size: ["=signW - 0.3", 0.08, 0.02], rotate: [0, 0, 3], at: ["=0", "=signY + (index == 0 ? 0.28 : -0.28)", "=D2 + 0.115"], region: "frame" },

        // ================= Mezzanine, stair and offices =================
        // Columns stand on the office partitions (or evenly spaced with no offices), never in a doorway.
        { id: "mezzDeck", type: "mesh.box", when: "=hasMezz", size: ["=width - 2 * pw - 0.04", 0.18, "=md - pw"], at: [0, "=mH - 0.09", "=(-D2 + pw + zM) / 2"], region: "deck" },
        { id: "mezzBeam", type: "mesh.box", when: "=hasMezz", size: ["=width - 2 * pw - 0.04", 0.3, 0.16], at: [0, "=mH - 0.15", "=zM - 0.08"], region: "frame" },
        { id: "mezzCols", type: "mesh.box", when: "=hasMezz", repeat: "=nOff > 0 ? nOff + 1 : nMezzCol", size: [0.18, "=mH - 0.3 - fl", 0.18], at: ["=nOff > 0 ? clamp(-W2 + pw + index * ow, -W2 + pw + 0.2, W2 - pw - 0.2) : -W2 + pw + 0.2 + index * (width - 2 * pw - 0.4) / (nMezzCol - 1)", "=fl + (mH - 0.3 - fl) / 2", "=zM - 0.1"], region: "frame" },
        { id: "mezzPosts", type: "mesh.box", when: "=hasMezz", repeat: "=nRailPost", size: [0.05, 1.05, 0.05], at: ["=railX0 + index * railLen / (nRailPost - 1)", "=mH + 0.525", "=zM - 0.06"], region: "frame" },
        { id: "mezzRails", type: "mesh.box", when: "=hasMezz", repeat: 3, size: ["=railLen", "=index == 2 ? 0.12 : 0.05", 0.05], at: ["=railX0 + railLen / 2", "=mH + [1.05, 0.55, 0.06][index]", "=zM - 0.06"], region: "frame" },
        { id: "stairTreads", type: "mesh.box", when: "=hasMezz", repeat: "=nR - 1", size: ["=stW", 0.04, "=go + 0.02"], at: ["=sx", "=fl + (index + 1) * rR - 0.02", "=zM + (nR - 1 - index - 0.5) * go"], region: "deck" },
        // Stringers: a band along the nosing line, cut level at the floor and plumb at the mezzanine.
        { id: "stringerShape", type: "curve.points", output: false, closed: true, points: [["=zM + run + (rR - 0.25) * go / rR", "=fl"], ["=zM + run + (rR + 0.05) * go / rR", "=fl"], ["=zM", "=mH + 0.05"], ["=zM", "=mH - 0.25"]] },
        { id: "stairStringers", type: "mesh.extrude", when: "=hasMezz", repeat: 2, outline: "@stringerShape", height: 0.05, rotate: [-90, -90, 0], at: ["=sx + (index == 0 ? -1 : 1) * (stW / 2 + 0.03) - 0.025", 0, 0], region: "frame" },
        { id: "stairRail", type: "mesh.box", when: "=hasMezz", size: [0.045, 0.045, "=run / cos(slopeS)"], rotate: ["=deg(slopeS)", 0, 0], at: ["=sx + stW / 2 + 0.03", "=fl + (mH - fl) / 2 + 0.9", "=zM + run / 2"], region: "frame" },
        { id: "stairRailPosts", type: "mesh.box", when: "=hasMezz", repeat: 3, size: [0.045, 0.95, 0.045], at: ["=sx + stW / 2 + 0.03", "=fl + rR * ((nR - 1) * (1 - index / 2)) + 0.475", "=zM + run * index / 2 + 0.05"], region: "frame" },
        { id: "officeWall", type: "curve.points", output: false, closed: true, points: [[0, 0], ["=ow - 1.4", 0], ["=ow - 1.4", 2.1], ["=ow - 0.45", 2.1], ["=ow - 0.45", 0], ["=ow", 0], ["=ow", "=offH"], [0, "=offH"]] },
        { id: "officeWindow", type: "curve.rect", output: false, width: "=owin", height: 1.1 },
        { id: "officeWindowAt", type: "curve.transform", output: false, curve: "@officeWindow", offset: ["=0.45 + owin / 2", 1.55] },
        { id: "officeFronts", type: "mesh.extrude", repeat: "=nOff", outline: "@officeWall", holes: { if: "=owin >= 0.6", then: ["@officeWindowAt"], else: [] }, height: 0.1, rotate: [-90, 0, 0], at: ["=-W2 + pw + index * ow", "=fl", "=zM - 0.2"], region: "offices" },
        { id: "officeGlass", type: "mesh.box", when: "=owin >= 0.6", repeat: "=nOff", keep: "=rand(index, 41) >= brokenPanes * 0.6", size: ["=owin", 1.1, 0.012], at: ["=-W2 + pw + index * ow + 0.45 + owin / 2", "=fl + 1.55", "=zM - 0.25"], region: "glass" },
        { id: "officeCross", type: "mesh.box", repeat: "=max(0, nOff - 1)", size: [0.1, "=offH", "=md - pw - 0.2"], at: ["=-W2 + pw + (index + 1) * ow", "=fl + offH / 2", "=(-D2 + pw + zM - 0.2) / 2"], region: "offices" },

        // ================= Fortifications =================
        {
            // index % 2: side of the door; floor(index / 2) % nBag: bag; floor(index / (2 nBag)): course.
            id: "sandbags", type: "mesh.box", when: "=barricade", repeat: "=2 * nBag * 4", keep: "=floor(index / 2) % nBag < nBag - floor(index / (2 * nBag)) % 2",
            size: ["=0.6 + rand(index, 51) * 0.06", 0.24, 0.4], radius: 0.1, segments: 2,
            rotate: [0, "=(rand(index, 52) - 0.5) * 10", "=(rand(index, 53) - 0.5) * 4"],
            at: ["=(index % 2 == 0 ? -1 : 1) * (bx0 + (floor(index / 2) % nBag + 0.5 + (floor(index / (2 * nBag)) % 2) * 0.5) * 0.64)", "=0.12 + floor(index / (2 * nBag)) * 0.22", "=bz + (rand(index, 54) - 0.5) * 0.06"], region: "sandbags",
        },
        // Czech hedgehogs: three square beams on the axes, stood on three of their ends.
        { id: "hhA", type: "mesh.box", output: false, size: [2.0, 0.15, 0.15] },
        { id: "hhB", type: "mesh.box", output: false, size: [0.15, 2.0, 0.15] },
        { id: "hhC", type: "mesh.box", output: false, size: [0.15, 0.15, 2.0] },
        { id: "hedgehogBody", type: "geo.join", output: false, meshes: ["@hhA", "@hhB", "@hhC"] },
        { id: "hedgehog", type: "geo.transform", output: false, mesh: "@hedgehogBody", rotate: [45, 0, 35.26] },
        { id: "hedgehogs", type: "geo.transform", when: "=barricade", repeat: 3, mesh: "@hedgehog", rest: true, rotate: [0, "=index * 47", 0], at: ["=[-rW / 2 - 1.2, rW / 2 + 1.4, -W2 - 0.4][index]", 0, "=bz + [2.4, 3.1, 1.9][index]"], region: "frame" },
        { id: "tyreStacks", type: "mesh.torus", when: "=barricade", repeat: 9, major: 0.36, minor: 0.13, segments: 24, sides: 10, rotate: [0, 0, "=(rand(index, 61) - 0.5) * 6"], at: ["=[-W2 + 0.6, W2 - 0.6, -rW / 2 - 0.7][floor(index / 3)] + (rand(index, 62) - 0.5) * 0.1", "=0.13 + (index % 3) * 0.26", "=bz - 1.1 + [0, 0.3, -0.2][floor(index / 3)]"], region: "tyres" },
        { id: "wirePath", type: "path.helix", output: false, radius: 0.22, pitch: 0.24, turns: "=(D + 0.4) / 0.24", segmentsPerTurn: 7 },
        { id: "eaveWire", type: "mesh.sweep", when: "=razorWire && roofShown", repeat: 2, path: "@wirePath", radius: 0.01, sides: 3, rotate: [90, 0, 0], at: ["=(index == 0 ? -1 : 1) * (W2 + 0.1)", "=eave + 0.28", "=-D2 - 0.2"], region: "wire" },
        { id: "wireBrackets", type: "mesh.box", when: "=razorWire && roofShown", repeat: "=2 * (bays + 1)", size: [0.03, 0.5, 0.03], rotate: [0, 0, "=(index % 2 == 0 ? 1 : -1) * 20"], at: ["=(index % 2 == 0 ? -1 : 1) * (W2 + 0.05)", "=eave + 0.15", "=zFrame0 + floor(index / 2) * frameStep"], region: "frame" },
        { id: "barricadeWirePath", type: "path.helix", output: false, radius: 0.28, pitch: 0.3, turns: "=(W2 + 1.4 - rW / 2 - 1.1) / 0.3", segmentsPerTurn: 7 },
        { id: "barricadeWire", type: "mesh.sweep", when: "=razorWire && barricade", repeat: 2, path: "@barricadeWirePath", radius: 0.01, sides: 3, rotate: [0, 0, "=index == 0 ? 90 : -90"], at: ["=(index == 0 ? -1 : 1) * bx0", "=1.2", "=bz"], region: "wire" },

        // ================= Watchtower =================
        { id: "towerPosts", type: "mesh.box", when: "=tower", repeat: 4, size: [0.16, "=tP + 2.7", 0.16], at: ["=tx + (index % 2 == 0 ? -1 : 1) * tIn", "=(tP + 2.7) / 2", "=tz + (index < 2 ? -1 : 1) * tIn"], region: "frame" },
        {
            // index % 4: face (front, back, left, right); floor(index / 4) % 2: diagonal; floor(index / 8): level.
            id: "towerBracesRaw", type: "mesh.box", output: false, repeat: "=8 * nL",
            size: ["=index % 4 < 2 ? brLen : 0.07", 0.07, "=index % 4 < 2 ? 0.07 : brLen"],
            rotate: ["=index % 4 < 2 ? 0 : (floor(index / 4) % 2 == 0 ? 1 : -1) * brAng", 0, "=index % 4 < 2 ? (floor(index / 4) % 2 == 0 ? 1 : -1) * brAng : 0"],
            at: ["=tx + [0, 0, -tIn, tIn][index % 4]", "=(floor(index / 8) + 0.5) * lvl", "=tz + [tIn, -tIn, 0, 0][index % 4]"], region: "frame",
        },
        { id: "towerBraces", type: "deform.clamp", when: "=tower", mesh: "@towerBracesRaw", min: 0, region: "frame" },
        { id: "towerRings", type: "mesh.box", when: "=tower", repeat: "=4 * nL", size: ["=index % 4 < 2 ? 2.6 : 0.08", 0.08, "=index % 4 < 2 ? 0.08 : 2.6"], at: ["=tx + [0, 0, -tIn, tIn][index % 4]", "=(floor(index / 4) + 1) * lvl - 0.1", "=tz + [tIn, -tIn, 0, 0][index % 4]"], region: "frame" },
        { id: "towerDeck", type: "mesh.box", when: "=tower", size: [3.0, 0.14, 3.0], at: ["=tx", "=tP + 0.07", "=tz"], region: "deck" },
        {
            // Parapet: front, back and right whole; the ladder side (-X) in two halves around the gap.
            id: "towerParapet", type: "mesh.box", when: "=tower", repeat: 5,
            size: ["=index < 2 ? 3.0 : 0.04", 1.1, "=index < 2 ? 0.04 : (index == 2 ? 3.0 : 1.1)"],
            at: ["=tx + [0, 0, 1.5, -1.5, -1.5][index]", "=tP + 0.69", "=tz + [1.5, -1.5, 0, -0.95, 0.95][index]"], region: "=index == 1 ? 'patch' : 'cladding'",
        },
        { id: "towerRoof", type: "mesh.box", when: "=tower", size: [3.5, 0.05, 3.5], rotate: [9, 0, 0], at: ["=tx", "=tP + 2.75", "=tz"], region: "roof" },
        { id: "ladderRails", type: "mesh.box", when: "=tower", repeat: 2, size: [0.05, "=tP + 1.1", 0.05], at: ["=tx - 1.62", "=(tP + 1.1) / 2", "=tz + (index == 0 ? -0.25 : 0.25)"], region: "frame" },
        { id: "ladderRungs", type: "mesh.box", when: "=tower", repeat: "=floor(tP / 0.3)", size: [0.035, 0.035, 0.5], at: ["=tx - 1.62", "=(index + 1) * 0.3", "=tz"], region: "frame" },
        { id: "searchlight", type: "mesh.cylinder", when: "=tower", radius: 0.22, height: 0.45, segments: 18, bevel: 0.03, rotate: [70, 30, 0], at: ["=tx + 0.6", "=tP + 1.35", "=tz + 1.2"], region: "frame" },
        { id: "searchGlow", type: "mesh.cylinder", when: "=tower", radius: 0.18, height: 0.02, segments: 18, rotate: [70, 30, 0], at: ["=tx + 0.6 + 0.44 * sin(rad(70)) * sin(rad(30))", "=tP + 1.35 + 0.44 * cos(rad(70))", "=tz + 1.2 + 0.44 * sin(rad(70)) * cos(rad(30))"], region: "lights" },
        { id: "turbineMast", type: "mesh.cylinder", when: "=tower && turbine", radius: 0.06, height: 2.2, segments: 10, at: ["=tx", "=tP + 2.75", "=tz - 0.6"], region: "frame" },
        { id: "turbineHub", type: "mesh.sphere", when: "=tower && turbine", radius: 0.16, segments: 14, rings: 7, at: ["=tx", "=tP + 4.95", "=tz - 0.42"], region: "patch" },
        { id: "turbineBlade", type: "mesh.box", output: false, size: [0.2, 1.35, 0.025], radius: 0.01, segments: 1, at: [0, 0.8, 0], rotate: [0, 12, 0] },
        { id: "turbineBlades", type: "geo.transform", when: "=tower && turbine", repeat: 3, mesh: "@turbineBlade", rotate: [0, 0, "=index * 120 + 17"], at: ["=tx", "=tP + 4.95", "=tz - 0.36"], region: "patch" },
        { id: "turbineTail", type: "mesh.box", when: "=tower && turbine", size: [0.02, 0.5, 0.9], at: ["=tx", "=tP + 4.98", "=tz - 1.1"], region: "sign" },
        { id: "tarp", type: "mesh.box", when: "=tower", size: [0.02, 0.9, 1.6], rotate: [0, 0, -4], at: ["=tx + 1.53", "=tP + 0.55", "=tz"], region: "tarp" },
    ],
    limits: { maxSize: 60, minSize: 8, maxTriangles: 300000 },
};

export default wastelandDepotDef;
