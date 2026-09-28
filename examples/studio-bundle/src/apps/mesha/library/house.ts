import type { ObjectDef } from "../mesha_object";

// A residential house you can walk through. Plan (front at +Z, x across the width):
//
//   +--------------+------+--------------+   A centre hall runs front to back with a straight
//   |  back left   | hall |  back right  |   stair along one of its walls. Cross walls split
//   |--------------|  ||  |--------------|   each side into a front and a back room, stacked on
//   |  front left  |  ||  |  front right |   every storey. Hall doors on the stair side sit in
//   +--------------+-door-+--------------+   the foyer and behind the stair's top, clear of it.
//
// Floor surfaces are at y_f = plinth + f * storeyHeight. Exterior walls are two leaves sharing
// their openings: the exterior finish outside and a thin interior-finish lining inside. Walls are
// extrusions of (u, up) outlines: rotate [-90, 0, 0] runs u along +X and the thickness toward -Z;
// rotate [-90, -90, 0] runs u along +Z and the thickness toward +X. Door openings are notches in
// the outline; window openings are holes. Every window, door, dormer and shutter set is evaluated
// once and placed with Transform, so a house of thirty windows costs one window.

export const houseDef: ObjectDef = {
    id: "architecture.house",
    name: "House",
    category: "Architecture",
    tags: ["house", "home", "residential", "building", "colonial", "cottage", "bungalow", "villa", "farmhouse", "townhouse", "stairs", "interior", "rooms"],
    description: "A walkable residential house: centre hall and staircase, rooms on every storey, real doors and windows, porch, roof with dormers and chimneys.",
    featured: ["storeys", "width", "depth", "roofStyle", "pitch", "porch", "dormers", "wallFinish", "roofFinish"],
    groups: [
        { id: "size", label: "House" },
        { id: "plan", label: "Floor plan" },
        { id: "stairs", label: "Staircase" },
        { id: "entry", label: "Entrance and porch" },
        { id: "windows", label: "Windows" },
        { id: "roof", label: "Roof" },
        { id: "details", label: "Details" },
        { id: "view", label: "Inspect" },
        { id: "materials", label: "Exterior materials" },
        { id: "interiorMaterials", label: "Interior materials" },
    ],
    params: [
        // --- House ---
        { id: "storeys", label: "Storeys", type: "int", default: 2, min: 1, max: 3, group: "size" },
        { id: "width", label: "Width", type: "number", default: 11, min: "=2 * 2.4 + stairWidth + 0.85 + 2 * wall + 0.24 + 0.2", max: 18, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 9.2, min: "=storeys > 1 ? max(6, 2 * wall + foyer + (ceil(storeyHeight / riser) - 1) * tread + 1.35) : 6", max: 16, unit: "m", group: "size", description: "The stair and its landings set the least depth for more than one storey." },
        { id: "storeyHeight", label: "Storey height", type: "number", default: 3, min: 2.7, max: 3.6, unit: "m", group: "size", description: "Floor to floor." },
        { id: "wall", label: "Wall thickness", type: "number", default: 0.32, min: 0.2, max: 0.45, unit: "m", group: "size" },
        { id: "plinth", label: "Floor raised", type: "number", default: 0.54, min: 0.15, max: 1.1, unit: "m", group: "size", description: "Ground floor above grade: the foundation, and the number of front steps." },
        // --- Floor plan ---
        { id: "hallWidth", label: "Hall width", type: "number", default: 2.3, min: "=stairWidth + 0.85", max: "=width - 2 * wall - 0.24 - 4.8", unit: "m", group: "plan" },
        { id: "hallOffset", label: "Hall position", type: "number", default: 0, min: -1, max: 1, group: "plan", description: "Slides the hall toward one side, keeping every room at least 2.4 m wide." },
        { id: "split", label: "Front room share", type: "number", default: 0.52, min: "=(zi1 - zcMax) / innerD", max: "=(zi1 - zcMin) / innerD", group: "plan", description: "How much of the depth the front rooms take; the cross walls stay clear of the hall doors." },
        { id: "groundPlan", label: "Ground floor", type: "enum", default: "rooms", options: ["rooms", "open"], optionLabels: ["Separate rooms", "Open plan"], group: "plan" },
        { id: "interiorDoors", label: "Interior doors", type: "enum", default: "panel", options: ["none", "panel", "glazed", "flush"], optionLabels: ["Open doorways", "Panelled", "Half glazed", "Flush"], group: "plan" },
        { id: "interiorDoorAngle", label: "Interior doors open", type: "number", default: 80, min: 0, max: 100, unit: "deg", group: "plan", visibleIf: "=interiorDoors != 'none'" },
        // --- Staircase ---
        { id: "stairSide", label: "Stair side", type: "enum", default: "left", options: ["left", "right"], optionLabels: ["Left wall", "Right wall"], group: "stairs", visibleIf: "=storeys > 1" },
        { id: "stairStyle", label: "Stair", type: "enum", default: "closed", options: ["closed", "open"], optionLabels: ["Closed risers", "Open treads"], group: "stairs", visibleIf: "=storeys > 1" },
        { id: "stairWidth", label: "Stair width", type: "number", default: 0.95, min: 0.8, max: 1.2, unit: "m", group: "stairs", visibleIf: "=storeys > 1" },
        { id: "riser", label: "Max riser", type: "number", default: 0.18, min: 0.16, max: 0.2, unit: "m", group: "stairs", visibleIf: "=storeys > 1" },
        { id: "tread", label: "Tread", type: "number", default: 0.27, min: 0.24, max: 0.32, unit: "m", group: "stairs", visibleIf: "=storeys > 1" },
        { id: "foyer", label: "Foyer depth", type: "number", default: 1.6, min: 1.2, max: 3, unit: "m", group: "stairs", visibleIf: "=storeys > 1", description: "Distance from the front wall to the first step." },
        { id: "balusters", label: "Balusters per tread", type: "int", default: 2, min: 1, max: 3, group: "stairs", visibleIf: "=storeys > 1" },
        // --- Entrance and porch ---
        { id: "doorWidth", label: "Front door width", type: "number", default: 1.0, min: 0.85, max: "=min(1.3, hallWidth - 0.35)", unit: "m", group: "entry" },
        { id: "doorHeight", label: "Front door height", type: "number", default: 2.1, min: 2.0, max: "=max(2, min(2.5, storeyHeight - 0.7))", unit: "m", group: "entry" },
        { id: "doorStyle", label: "Front door", type: "enum", default: "panel", options: ["panel", "glazed", "flush", "plank"], optionLabels: ["Raised panels", "Half glazed", "Flush", "Ledged plank"], group: "entry" },
        { id: "fanlight", label: "Fanlight", type: "number", default: 0.4, min: 0, max: "=max(0, min(0.7, doorWidth * 0.6, storeyHeight - 0.5 - doorHeight))", unit: "m", group: "entry" },
        { id: "frontDoorAngle", label: "Front door open", type: "number", default: 0, min: 0, max: 90, unit: "deg", group: "entry" },
        { id: "porch", label: "Porch", type: "enum", default: "portico", options: ["none", "portico", "veranda"], optionLabels: ["Stoop", "Portico", "Veranda"], group: "entry" },
        { id: "porchPosts", label: "Porch posts", type: "enum", default: "turned", options: ["turned", "square"], optionLabels: ["Turned columns", "Square posts"], group: "entry", visibleIf: "=porch != 'none'" },
        { id: "porchDepth", label: "Porch depth", type: "number", default: 1.8, min: 1.2, max: 3.2, unit: "m", group: "entry", visibleIf: "=porch != 'none'" },
        // --- Windows ---
        { id: "windowsPerRoom", label: "Windows per room", type: "int", default: 2, min: 1, max: 3, group: "windows", description: "Front and back walls; windows are centred on each room, clear of the partitions." },
        { id: "sideWindows", label: "Side windows per room", type: "int", default: 1, min: 0, max: 2, group: "windows" },
        { id: "windowWidth", label: "Window width", type: "number", default: 0.95, min: 0.6, max: "=min(1.8, shutters ? (minZone - 0.4) / 2 : minZone - 0.6)", unit: "m", group: "windows" },
        { id: "windowHeight", label: "Window height", type: "number", default: 1.6, min: 0.9, max: "=storeyHeight - 0.55 - sillHeight", unit: "m", group: "windows" },
        { id: "sillHeight", label: "Sill height", type: "number", default: 0.75, min: 0.3, max: 1.1, unit: "m", group: "windows" },
        { id: "windowArch", label: "Window arch", type: "number", default: 0, min: 0, max: "=min(windowWidth / 2, windowHeight * 0.4)", unit: "m", group: "windows" },
        { id: "windowStyle", label: "Opening", type: "enum", default: "sash", options: ["casement", "sash", "fixed"], optionLabels: ["Casement", "Sash", "Fixed"], group: "windows" },
        { id: "panesX", label: "Panes across", type: "int", default: 2, min: 1, max: 4, group: "windows" },
        { id: "panesY", label: "Panes down", type: "int", default: 3, min: 1, max: 4, group: "windows" },
        { id: "shutters", label: "Shutters", type: "bool", default: true, group: "windows" },
        { id: "lintels", label: "Lintels and keystones", type: "bool", default: true, group: "windows" },
        // --- Roof ---
        { id: "roofStyle", label: "Roof", type: "enum", default: "gable", options: ["gable", "hip", "flat"], optionLabels: ["Gable", "Hip", "Flat"], group: "roof" },
        { id: "pitch", label: "Pitch", type: "number", default: 38, min: 15, max: 55, unit: "deg", group: "roof", visibleIf: "=roofStyle != 'flat'" },
        { id: "overhang", label: "Eaves overhang", type: "number", default: 0.45, min: 0.1, max: 0.9, unit: "m", group: "roof" },
        { id: "dormers", label: "Dormers", type: "int", default: 3, min: 0, max: 4, group: "roof", visibleIf: "=roofStyle != 'flat'", description: "Gabled dormers on the front slope; only as many as the roof has room for." },
        { id: "gableWindow", label: "Gable windows", type: "bool", default: true, group: "roof", visibleIf: "=roofStyle == 'gable'" },
        { id: "chimneys", label: "Chimneys", type: "int", default: 2, min: 0, max: 2, group: "roof" },
        // --- Details ---
        { id: "corners", label: "Corners", type: "enum", default: "quoins", options: ["none", "boards", "quoins"], optionLabels: ["Plain", "Corner boards", "Quoins"], group: "details" },
        { id: "beltCourse", label: "Belt course", type: "bool", default: true, group: "details", description: "A band marking each upper floor on the outside." },
        { id: "gutters", label: "Gutters", type: "bool", default: true, group: "details", visibleIf: "=roofStyle != 'flat'" },
        // --- Inspect ---
        { id: "roofVisible", label: "Show roof", type: "bool", default: true, group: "view", variation: 0, description: "Lift the roof and top ceiling off to look into the top storey." },
        { id: "cutaway", label: "Hide top storeys", type: "int", default: 0, min: 0, max: "=storeys - 1", group: "view", variation: 0, description: "Remove storeys from the top down to look into the rooms and stairs below." },
        // --- Materials ---
        { id: "wallFinish", label: "Walls", type: "material", default: "masonry.brick", materials: ["masonry", "paint", "stone", "wood"], group: "materials" },
        { id: "trimFinish", label: "Trim", type: "material", default: "paint.white", materials: ["paint", "wood", "stone", "metal.black", "metal.steel", "metal.aluminum"], group: "materials" },
        { id: "dressingFinish", label: "Sills, lintels and quoins", type: "material", default: "stone.sandstone", materials: ["stone", "paint", "masonry"], group: "materials" },
        { id: "roofFinish", label: "Roof", type: "material", default: "roofing.slate", materials: ["roofing", "metal.zinc", "metal.copper", "stone.slate"], group: "materials" },
        { id: "windowFinish", label: "Window frames", type: "material", default: "paint.white", materials: ["paint", "wood", "metal.black", "metal.aluminum"], group: "materials" },
        { id: "doorFinish", label: "Front door", type: "material", default: "paint.navy", materials: ["paint", "wood"], group: "materials" },
        { id: "shutterFinish", label: "Shutters", type: "material", default: "paint.black", materials: ["paint", "wood"], group: "materials", visibleIf: "=shutters" },
        { id: "chimneyFinish", label: "Chimneys", type: "material", default: "masonry.brick", materials: ["masonry", "stone"], group: "materials", visibleIf: "=chimneys > 0" },
        { id: "foundationFinish", label: "Foundation", type: "material", default: "stone.granite", materials: ["stone", "masonry"], group: "materials" },
        { id: "interiorFinish", label: "Interior walls", type: "material", default: "paint.white", materials: ["paint", "masonry.stucco", "masonry.whitewash", "wood"], group: "interiorMaterials" },
        { id: "interiorDoorFinish", label: "Interior doors", type: "material", default: "paint.white", materials: ["paint", "wood"], group: "interiorMaterials", visibleIf: "=interiorDoors != 'none'" },
        { id: "floorFinish", label: "Floors", type: "material", default: "wood.oak", materials: ["wood", "stone"], group: "interiorMaterials" },
        { id: "stairFinish", label: "Treads and handrails", type: "material", default: "wood.walnut", materials: ["wood", "stone.marble", "paint"], group: "interiorMaterials", visibleIf: "=storeys > 1" },
        { id: "seed", label: "Seed", type: "seed", default: 17, group: "materials", variation: 0 },
    ],
    derived: {
        // Storeys and shell.
        shownN: "=max(1, storeys - cutaway)",
        roofShown: "=roofVisible && shownN == storeys",
        H: "=storeyHeight", tw: "=wall", s: 0.25, lin: 0.02, pt: 0.12, pl: "=plinth",
        yTop: "=pl + storeys * H",
        W2: "=width / 2", D2: "=depth / 2",
        xi0: "=-W2 + tw", xi1: "=W2 - tw", zi0: "=-D2 + tw", zi1: "=D2 - tw", innerD: "=depth - 2 * tw",
        // Hall and rooms.
        hw: "=hallWidth",
        hallX: "=hallOffset * max(0, (width - 2 * tw - hw - 2 * pt) / 2 - 2.4)",
        hallL: "=hallX - hw / 2", hallR: "=hallX + hw / 2",
        xPL: "=hallL - pt / 2", xPR: "=hallR + pt / 2",
        cL: "=(xi0 + hallL - pt) / 2", cR: "=(hallR + pt + xi1) / 2",
        zwL: "=hallL - pt - xi0", zwR: "=xi1 - hallR - pt",
        minZone: "=min(zwL, zwR)",
        // Staircase: nR risers of rh, steps treads, rising toward -Z from zS to zE.
        hasStair: "=storeys > 1",
        sgn: "=stairSide == 'left' ? -1 : 1",
        nR: "=ceil(H / riser)", rh: "=H / nR", steps: "=nR - 1", run: "=steps * tread",
        zS: "=zi1 - foyer", zE: "=zS - run",
        sOut: "=hallX + sgn * hw / 2", sIn: "=sOut - sgn * stairWidth", sX: "=hallX + sgn * (hw - stairWidth) / 2",
        slope: "=atan2(rh, tread)",
        stringZ: "=(zS + zE + tread) / 2 - 0.02",
        stairsShown: "=hasStair ? min(storeys - 1, shownN) : 0",
        guardsShown: "=hasStair ? shownN - 1 : 0",
        endGuards: "=guardsShown - min(guardsShown, max(0, stairsShown - 1))",
        xRail: "=sIn + sgn * 0.03", xGuard: "=sIn - sgn * 0.03",
        treadT: "=stairStyle == 'open' ? 0.05 : 0.035",
        treadW: "=stairStyle == 'open' ? stairWidth - 0.13 : stairWidth",
        nGuard: "=max(2, floor(run / 0.12))", nGuardEnd: "=max(1, floor(stairWidth / 0.12))",
        // Cross walls and hall doors (interior door opening iwo x iho including its frame).
        iwo: 0.92, iho: 2.1,
        zcMax: "=min(zi1 - 2.26, hasStair ? zi1 - foyer / 2 - 0.62 : zi1)",
        zcMin: "=max(zi0 + 2.26, hasStair ? (zi0 + zE) / 2 + 0.62 : zi0)",
        zc: "=zi1 - split * innerD",
        zFr0: "=zc + pt / 2", zBk1: "=zc - pt / 2",
        zmF: "=(zFr0 + zi1) / 2", zmB: "=(zi0 + zBk1) / 2",
        zdSF: "=hasStair ? zi1 - foyer / 2 : zmF", zdSB: "=hasStair ? (zi0 + zE) / 2 : zmB",
        zdLF: "=sgn < 0 ? zdSF : zmF", zdLB: "=sgn < 0 ? zdSB : zmB",
        zdRF: "=sgn > 0 ? zdSF : zmF", zdRB: "=sgn > 0 ? zdSB : zmB",
        crossStart: "=groundPlan == 'open' ? 1 : 0",
        // Front door opening (frame included).
        hasFan: "=fanlight > 0.05",
        dwo: "=doorWidth + 0.1",
        dho: "=doorHeight + (hasFan ? 0.05 + fanlight : 0) + 0.05",
        // Windows: rows centred on each room.
        ww: "=windowWidth", wh: "=windowHeight", sh: "=sillHeight",
        gap: "=shutters ? ww + 0.3 : max(0.5, ww * 0.6)",
        pitchW: "=ww + gap",
        margin: "=shutters ? ww + 0.4 : 0.6",
        kL: "=min(windowsPerRoom, max(1, floor((zwL - margin + gap) / pitchW)))",
        kR: "=min(windowsPerRoom, max(1, floor((zwR - margin + gap) / pitchW)))",
        kRow: "=kL + kR",
        kSF: "=min(sideWindows, max(0, floor((zi1 - zFr0 - margin + gap) / pitchW)))",
        kSB: "=min(sideWindows, max(0, floor((zBk1 - zi0 - margin + gap) / pitchW)))",
        kSide: "=kSF + kSB",
        hwWin: "=shutters ? min(ww, (hw - 0.3) / 2) : min(ww, hw - 0.4)",
        winDepth: "=tw * 0.4",
        // Roof.
        tp: "=tan(rad(pitch))", o: "=overhang",
        k: "=0.2 / cos(rad(pitch))",
        yEave: "=yTop - o * tp", yRidge: "=yTop + D2 * tp",
        ha: "=W2 + o", hb: "=D2 + o",
        hipBase: "=yTop - 0.02",
        hipH: "=min(ha, hb) * tp",
        peak: "=roofStyle == 'gable' ? yRidge + k : roofStyle == 'hip' ? hipBase + hipH : yTop + 0.32",
        gutterY: "=roofStyle == 'gable' ? yEave - 0.03 : hipBase - 0.13",
        gutterZ: "=hb + 0.09",
        // Gable windows.
        gww: "=min(ww, 0.9)",
        gwh: "=min(1.3, (D2 - gww / 2) * tp - 0.6)",
        gArch: "=min(gww / 2, gwh * 0.45)",
        hasGableWin: "=roofStyle == 'gable' && gableWindow && gwh >= 0.6",
        // Dormers on the front slope.
        dww: "=min(ww, 1.0)", dwh: "=min(wh * 0.8, 1.3)", dW: "=dww + 0.5",
        dzf: "=D2 - 0.35", dtp: "=tan(rad(50))", dk: "=0.12 / cos(rad(50))",
        ySurfF: "=roofStyle == 'gable' ? yTop + (D2 - dzf) * tp + k : hipBase + (hb - dzf) * tp",
        yd0: "=ySurfF - 0.04",
        dH: "=dwh + 0.45",
        yDR: "=yd0 + dH + dW / 2 * dtp + dk",
        dzMeet: "=dzf - (yDR + 0.05 - ySurfF) / tp",
        dLen: "=dzf - dzMeet + 0.3",
        dHalfSpan: "=roofStyle == 'gable' ? W2 - 0.7 : W2 - D2 + dzf - dH / tp - 0.3",
        dFit: "=roofStyle != 'flat' && (roofStyle == 'gable' || width > depth + 1) && dzMeet > 0.2 && yDR + 0.25 < peak && 2 * dHalfSpan >= dW",
        ndFit: "=dFit ? floor((2 * dHalfSpan - dW) / (dW + 0.5)) + 1 : 0",
        nDormers: "=roofShown ? min(dormers, ndFit) : 0",
        dPitch: "=nDormers > 1 ? min(3.4, (2 * dHalfSpan - dW) / (nDormers - 1)) : 0",
        // Chimneys.
        cw: 0.9, cd: 0.7,
        chimX: "=W2 - tw - cw / 2 - 0.35",
        chimZ: "=roofStyle == 'flat' ? -D2 + tw + cd / 2 + 0.6 : -cd / 2 - 0.15",
        // Clear the roof where the stack stands by 0.9 m (hip roofs fall away toward the ends).
        chimTop: "=roofStyle == 'hip' ? hipBase + min(hipH, min(ha - chimX + cw / 2, hb - abs(chimZ) + cd / 2) * tp) + 0.9 : peak + (roofStyle == 'flat' ? 1.1 : 0.8)",
        chimBase: "=yTop - s",
        // Porch.
        hasPorch: "=porch != 'none'",
        porchW: "=porch == 'veranda' ? width : min(width - 0.4, dwo + 2.1)",
        porchX: "=porch == 'veranda' ? 0 : clamp(hallX, -W2 + porchW / 2 + 0.1, W2 - porchW / 2 - 0.1)",
        pd: "=porch == 'none' ? 1.1 : porchDepth",
        yb: "=pl + min(max(dho + 0.3, 2.45), H - 0.3, porchLimit - pl - 0.32)",
        // Porch roofs stop under the upper windows; on one storey a portico gable ties into the eave, a veranda tucks under it.
        eaveUnder: "=roofStyle == 'gable' ? yEave - 0.05 : roofStyle == 'hip' ? hipBase - 0.25 : yTop - 0.05",
        porchLimit: "=storeys > 1 ? pl + H + sh - 0.12 : porch == 'portico' ? (roofStyle == 'gable' ? yTop + k - 0.05 : roofStyle == 'hip' ? hipBase + o * tp - 0.05 : yTop - 0.05) : eaveUnder",
        pedEave: "=porchW / 2 + 0.15",
        pedRise: "=max(0.15, min(pedEave * tan(rad(30)), porchLimit - yb - 0.25 - 0.14))",
        nBays: "=max(2, round((width - 0.5) / 2.6))", bay: "=(width - 0.5) / nBays",
        stepBay: "=clamp(floor((hallX + W2 - 0.25) / bay), 0, nBays - 1)",
        stepX: "=porch == 'veranda' ? -W2 + 0.25 + (stepBay + 0.5) * bay : porch == 'portico' ? porchX : hallX",
        stepW: "=porch == 'veranda' ? min(1.8, bay - 0.4) : porch == 'portico' ? min(porchW - 0.5, dwo + 1.0) : dwo + 0.6",
        nSteps: "=ceil(pl / 0.18)", stepRise: "=pl / nSteps",
        zPorchFront: "=D2 + pd",
        shedHigh: "=max(yb + 0.3, min(yb + 0.25 + pd * tan(rad(18)), porchLimit))",
        shedSlope: "=(shedHigh - yb - 0.25) / (pd - 0.1)",
        nBal: "=max(3, floor((bay - 0.3) / 0.14))",
        nSideBal: "=max(3, floor((pd - 0.5) / 0.14))",
        colH: "=yb - pl",
        // Quoins.
        nQuoins: "=max(1, floor((shownN * H - 0.04) / 0.32))",
    },
    rules: [
        { check: "=!hasStair || (2 * rh + tread >= 0.58 && 2 * rh + tread <= 0.68)", message: "Riser and tread break the 2R + T walking rule (0.58 to 0.68 m)." },
        { check: "=dormers == 0 || roofStyle == 'flat' || ndFit > 0", message: "The roof is too low or short for dormers." },
        { check: "=dormers <= ndFit || ndFit == 0 || roofStyle == 'flat'", message: "Not every dormer fits on this roof." },
        { check: "=sideWindows == 0 || kSide >= sideWindows", message: "The side rooms are too shallow for their windows." },
        { check: "=porch != 'portico' || roofStyle == 'flat' || pedRise >= 0.35", message: "The portico pediment is squeezed flat under the windows or eaves above it." },
        { check: "=hallWidth - stairWidth >= 0.9 || !hasStair", message: "The hall beside the stair is tight for passing." },
        { check: "=porch == 'none' || yb >= pl + dho", message: "The porch beam runs across the front door: raise the storey or lower the door." },
    ],
    regions: {
        exterior: { label: "Walls", material: "=wallFinish" },
        interior: { label: "Interior walls", material: "=interiorFinish" },
        ceiling: { label: "Ceilings", material: "=interiorFinish" },
        floors: { label: "Floors", material: "=floorFinish" },
        foundation: { label: "Foundation", material: "=foundationFinish" },
        dressing: { label: "Sills, lintels and quoins", material: "=dressingFinish" },
        trim: { label: "Trim", material: "=trimFinish" },
        roof: { label: "Roof", material: "=roofFinish" },
        chimney: { label: "Chimneys", material: "=chimneyFinish" },
        pots: { label: "Chimney pots", material: "roofing.clay" },
        gutters: { label: "Gutters", material: "=trimFinish" },
        frame: { label: "Window frames", material: "=windowFinish" },
        glass: { label: "Glass", material: "glass.clear" },
        sill: { label: "Window sills", material: "=dressingFinish" },
        hardware: { label: "Hardware", material: "metal.brass" },
        casing: { label: "Door frames", material: "=trimFinish" },
        leaf: { label: "Interior doors", material: "=interiorDoorFinish" },
        entry: { label: "Front door", material: "=doorFinish" },
        shutters: { label: "Shutters", material: "=shutterFinish" },
        treads: { label: "Treads and handrails", material: "=stairFinish" },
        stair: { label: "Risers and balusters", material: "=trimFinish" },
    },
    presets: [
        { name: "Brick colonial", values: {} },
        { name: "Craftsman bungalow", values: { storeys: 1, width: 12, depth: 10, plinth: 0.7, pitch: 26, overhang: 0.85, porch: "veranda", porchDepth: 2.6, dormers: 0, chimneys: 1, windowStyle: "casement", panesX: 3, panesY: 2, windowHeight: 1.45, shutters: false, lintels: false, corners: "boards", fanlight: 0, doorStyle: "glazed", wallFinish: "paint.sage", trimFinish: "paint.white", dressingFinish: "paint.white", roofFinish: "roofing.cedar", windowFinish: "wood.walnut", doorFinish: "wood.oak", foundationFinish: "masonry.fieldstone", chimneyFinish: "masonry.fieldstone", interiorFinish: "masonry.stucco", floorFinish: "wood.cherry" } },
        { name: "Modern flat roof", values: { storeys: 2, width: 13, depth: 10, storeyHeight: 3.2, plinth: 0.2, roofStyle: "flat", overhang: 0.9, porch: "portico", porchPosts: "square", porchDepth: 2.2, windowStyle: "fixed", panesX: 1, panesY: 2, windowWidth: 1.5, windowHeight: 2.1, sillHeight: 0.4, windowsPerRoom: 1, sideWindows: 1, shutters: false, lintels: false, corners: "none", beltCourse: false, chimneys: 0, fanlight: 0, doorStyle: "flush", doorHeight: 2.4, stairStyle: "open", interiorDoors: "flush", wallFinish: "paint.white", trimFinish: "metal.black", dressingFinish: "stone.slate", roofFinish: "metal.zinc", windowFinish: "metal.black", doorFinish: "wood.walnut", foundationFinish: "stone.slate", floorFinish: "wood.ash", stairFinish: "wood.walnut", interiorDoorFinish: "wood.walnut" } },
        { name: "Georgian manor", values: { storeys: 3, width: 15, depth: 11, storeyHeight: 3.4, plinth: 0.9, hallWidth: 2.8, roofStyle: "hip", pitch: 32, overhang: 0.35, dormers: 3, windowsPerRoom: 2, windowHeight: 1.9, windowWidth: 1.05, shutters: false, panesX: 3, panesY: 4, sideWindows: 2, fanlight: 0.5, doorWidth: 1.2, doorHeight: 2.4, wallFinish: "masonry.stucco", dressingFinish: "stone.sandstone", roofFinish: "roofing.slate", doorFinish: "paint.black", chimneyFinish: "masonry.buff", foundationFinish: "stone.sandstone", floorFinish: "stone.marble", stairFinish: "stone.marble" } },
        { name: "White farmhouse", values: { storeys: 2, width: 11.5, depth: 8.8, pitch: 45, overhang: 0.3, porch: "veranda", porchDepth: 2.4, dormers: 2, chimneys: 1, corners: "boards", lintels: false, windowStyle: "sash", panesX: 2, panesY: 2, fanlight: 0, doorStyle: "glazed", wallFinish: "paint.white", trimFinish: "paint.white", dressingFinish: "paint.white", roofFinish: "roofing.seam", shutterFinish: "paint.sage", windowFinish: "paint.white", doorFinish: "paint.terracotta", chimneyFinish: "masonry.brick", foundationFinish: "masonry.fieldstone", stairFinish: "wood.oak" } },
        { name: "Stone cottage", values: { storeys: 1, width: 9, depth: 7, storeyHeight: 3.0, plinth: 0.3, pitch: 50, overhang: 0.2, porch: "portico", porchDepth: 1.4, dormers: 2, chimneys: 2, windowStyle: "casement", panesX: 2, panesY: 2, windowWidth: 0.8, windowHeight: 1.2, windowsPerRoom: 1, shutters: true, lintels: true, corners: "quoins", beltCourse: false, doorStyle: "plank", fanlight: 0, doorWidth: 0.9, doorHeight: 2.0, wallFinish: "masonry.fieldstone", dressingFinish: "stone.granite", roofFinish: "roofing.clay", shutterFinish: "paint.sage", windowFinish: "paint.white", doorFinish: "wood.oak", chimneyFinish: "masonry.fieldstone", foundationFinish: "stone.granite", interiorFinish: "masonry.whitewash", floorFinish: "stone.slate" } },
    ],
    nodes: [
        // ================= Ground and floors =================
        { id: "foundation", type: "mesh.box", size: ["=width + 0.06", "=pl", "=depth + 0.06"], at: [0, "=pl / 2", 0], region: "foundation" },
        { id: "groundBoards", type: "mesh.box", size: ["=xi1 - xi0", 0.024, "=innerD"], at: [0, "=pl - 0.008", 0], region: "floors" },
        { id: "slabOutline", type: "curve.points", output: false, closed: true, points: [["=xi0", "=zi0"], ["=xi1", "=zi0"], ["=xi1", "=zi1"], ["=xi0", "=zi1"]] },
        { id: "stairwell", type: "curve.points", output: false, closed: true, points: [["=min(sOut, sIn)", "=zE"], ["=max(sOut, sIn)", "=zE"], ["=max(sOut, sIn)", "=zS"], ["=min(sOut, sIn)", "=zS"]] },
        { id: "slabs", type: "mesh.extrude", repeat: "=shownN - 1", outline: "@slabOutline", holes: ["@stairwell"], height: "=s - 0.02", at: [0, "=pl + (index + 1) * H - s", 0], region: "ceiling" },
        { id: "boards", type: "mesh.extrude", repeat: "=shownN - 1", outline: "@slabOutline", holes: ["@stairwell"], height: 0.024, at: [0, "=pl + (index + 1) * H - 0.02", 0], region: "floors" },
        { id: "topCeiling", type: "mesh.extrude", when: "=roofShown", outline: "@slabOutline", height: "=s", at: [0, "=yTop - s", 0], region: "ceiling" },

        // ================= Exterior walls =================
        // Opening shapes (u, up) on each wall; rows are centred on the rooms behind them.
        { id: "roomHole", type: "curve.arch", output: false, width: "=ww - 0.004", height: "=wh - 0.004", rise: "=windowArch", segments: 20 },
        { id: "hallHole", type: "curve.arch", output: false, width: "=hwWin - 0.004", height: "=wh - 0.004", rise: "=min(windowArch, hwWin / 2, wh * 0.4)", segments: 20 },
        { id: "rowLAt", type: "curve.transform", output: false, curve: "@roomHole", offset: ["=cL", "=sh + 0.002"] },
        { id: "rowL", type: "curves.linear", output: false, curve: "@rowLAt", count: "=kL", offset: ["=pitchW", 0] },
        { id: "rowRAt", type: "curve.transform", output: false, curve: "@roomHole", offset: ["=cR", "=sh + 0.002"] },
        { id: "rowR", type: "curves.linear", output: false, curve: "@rowRAt", count: "=kR", offset: ["=pitchW", 0] },
        { id: "hallHoleAt", type: "curve.transform", output: false, curve: "@hallHole", offset: ["=hallX", "=sh + 0.002"] },
        { id: "sideFAt", type: "curve.transform", output: false, curve: "@roomHole", offset: ["=zmF", "=sh + 0.002"] },
        { id: "sideF", type: "curves.linear", output: false, curve: "@sideFAt", count: "=max(1, kSF)", offset: ["=pitchW", 0] },
        { id: "sideBAt", type: "curve.transform", output: false, curve: "@roomHole", offset: ["=zmB", "=sh + 0.002"] },
        { id: "sideB", type: "curves.linear", output: false, curve: "@sideBAt", count: "=max(1, kSB)", offset: ["=pitchW", 0] },
        // Outlines: outer leaves wrap the corners, linings stay inside them.
        { id: "frontOuterG", type: "curve.points", output: false, closed: true, points: [["=-W2", 0], ["=hallX - dwo / 2", 0], ["=hallX - dwo / 2", "=dho"], ["=hallX + dwo / 2", "=dho"], ["=hallX + dwo / 2", 0], ["=W2", 0], ["=W2", "=H"], ["=-W2", "=H"]] },
        { id: "frontLiningG", type: "curve.points", output: false, closed: true, points: [["=xi0 - lin", 0], ["=hallX - dwo / 2", 0], ["=hallX - dwo / 2", "=dho"], ["=hallX + dwo / 2", "=dho"], ["=hallX + dwo / 2", 0], ["=xi1 + lin", 0], ["=xi1 + lin", "=H"], ["=xi0 - lin", "=H"]] },
        { id: "fbOuter", type: "curve.points", output: false, closed: true, points: [["=-W2", 0], ["=W2", 0], ["=W2", "=H"], ["=-W2", "=H"]] },
        { id: "fbLining", type: "curve.points", output: false, closed: true, points: [["=xi0 - lin", 0], ["=xi1 + lin", 0], ["=xi1 + lin", "=H"], ["=xi0 - lin", "=H"]] },
        { id: "sideOuter", type: "curve.points", output: false, closed: true, points: [["=-D2 + tw - lin", 0], ["=D2 - tw + lin", 0], ["=D2 - tw + lin", "=H"], ["=-D2 + tw - lin", "=H"]] },
        { id: "sideLining", type: "curve.points", output: false, closed: true, points: [["=zi0", 0], ["=zi1", 0], ["=zi1", "=H"], ["=zi0", "=H"]] },
        // Layer = index % 2: 0 the outer leaf, 1 the lining.
        {
            id: "frontWallG", type: "mesh.extrude", repeat: 2, outline: { if: "=index == 0", then: "@frontOuterG", else: "@frontLiningG" }, holes: ["@rowL", "@rowR"],
            height: "=index == 0 ? tw - lin : lin", rotate: [-90, 0, 0], at: [0, "=pl", "=D2 - index * (tw - lin)"], region: "=index == 0 ? 'exterior' : 'interior'",
        },
        {
            id: "frontWallU", type: "mesh.extrude", repeat: "=2 * (shownN - 1)", outline: { if: "=index % 2 == 0", then: "@fbOuter", else: "@fbLining" }, holes: ["@rowL", "@rowR", "@hallHoleAt"],
            height: "=index % 2 == 0 ? tw - lin : lin", rotate: [-90, 0, 0], at: [0, "=pl + (floor(index / 2) + 1) * H", "=D2 - (index % 2) * (tw - lin)"], region: "=index % 2 == 0 ? 'exterior' : 'interior'",
        },
        {
            id: "backWall", type: "mesh.extrude", repeat: "=2 * shownN", outline: { if: "=index % 2 == 0", then: "@fbOuter", else: "@fbLining" }, holes: ["@rowL", "@rowR", "@hallHoleAt"],
            height: "=index % 2 == 0 ? tw - lin : lin", rotate: [-90, 0, 0], at: [0, "=pl + floor(index / 2) * H", "=index % 2 == 0 ? -D2 + tw - lin : -D2 + tw"], region: "=index % 2 == 0 ? 'exterior' : 'interior'",
        },
        {
            // index % 2: layer; floor(index / 2) % 2: left or right; floor(index / 4): storey.
            id: "sideWalls", type: "mesh.extrude", repeat: "=4 * shownN", outline: { if: "=index % 2 == 0", then: "@sideOuter", else: "@sideLining" },
            holes: [{ if: "=kSF > 0", then: "@sideF", else: [] }, { if: "=kSB > 0", then: "@sideB", else: [] }],
            height: "=index % 2 == 0 ? tw - lin : lin", rotate: [-90, -90, 0],
            at: ["=floor(index / 2) % 2 == 0 ? (index % 2 == 0 ? -W2 : -W2 + tw - lin) : (index % 2 == 0 ? W2 - tw + lin : W2 - tw)", "=pl + floor(index / 4) * H", 0],
            region: "=index % 2 == 0 ? 'exterior' : 'interior'",
        },

        // ================= Interior walls =================
        // Hall walls with two doorways each; on the stair side they sit in the foyer and past the stair's top.
        { id: "hallWallL", type: "curve.points", output: false, closed: true, points: [["=zi0", 0], ["=zdLB - iwo / 2", 0], ["=zdLB - iwo / 2", "=iho"], ["=zdLB + iwo / 2", "=iho"], ["=zdLB + iwo / 2", 0], ["=zdLF - iwo / 2", 0], ["=zdLF - iwo / 2", "=iho"], ["=zdLF + iwo / 2", "=iho"], ["=zdLF + iwo / 2", 0], ["=zi1", 0], ["=zi1", "=H"], ["=zi0", "=H"]] },
        { id: "hallWallR", type: "curve.points", output: false, closed: true, points: [["=zi0", 0], ["=zdRB - iwo / 2", 0], ["=zdRB - iwo / 2", "=iho"], ["=zdRB + iwo / 2", "=iho"], ["=zdRB + iwo / 2", 0], ["=zdRF - iwo / 2", 0], ["=zdRF - iwo / 2", "=iho"], ["=zdRF + iwo / 2", "=iho"], ["=zdRF + iwo / 2", 0], ["=zi1", 0], ["=zi1", "=H"], ["=zi0", "=H"]] },
        { id: "hallWalls", type: "mesh.extrude", repeat: "=2 * shownN", outline: { if: "=index % 2 == 0", then: "@hallWallL", else: "@hallWallR" }, height: "=pt", rotate: [-90, -90, 0], at: ["=(index % 2 == 0 ? xPL : xPR) - pt / 2", "=pl + floor(index / 2) * H", 0], region: "interior" },
        { id: "crossWalls", type: "mesh.box", repeat: "=2 * (shownN - crossStart)", size: ["=index % 2 == 0 ? zwL : zwR", "=H", "=pt"], at: ["=index % 2 == 0 ? cL : cR", "=pl + (floor(index / 2) + crossStart + 0.5) * H", "=zc"], region: "interior" },

        // ================= Doors =================
        {
            id: "frontDoor", type: "object", object: "architecture.door",
            params: { width: "=doorWidth", height: "=doorHeight", depth: "=tw", exterior: true, style: "=doorStyle", fanlight: "=fanlight", fanBars: 7, openAngle: "=frontDoorAngle", casingWidth: 0.12, frameWidth: 0.05, panelColumns: 2, panelRows: 3, handle: "knob" },
            // Hinged on the side away from the stair.
            scale: ["=stairSide == 'left' ? -1 : 1", 1, 1], at: ["=hallX", "=pl", "=D2 - tw / 2"],
        },
        {
            id: "interiorDoor", type: "object", object: "architecture.door", output: false, when: "=interiorDoors != 'none'",
            params: { width: "=iwo - 0.1", height: "=iho - 0.05", depth: "=pt", style: "=interiorDoors == 'none' ? 'panel' : interiorDoors", openAngle: "=interiorDoorAngle", casingWidth: 0.07, frameWidth: 0.05, panelColumns: 2, panelRows: 2, handle: "lever" },
        },
        // Per storey: left wall front and back, right wall front and back; each opens into its room.
        {
            id: "interiorDoorUnits", type: "geo.transform", when: "=interiorDoors != 'none'", repeat: "=4 * shownN", mesh: "@interiorDoor",
            rotate: [0, "=index % 4 < 2 ? 90 : -90", 0],
            at: ["=index % 4 < 2 ? xPL : xPR", "=pl + floor(index / 4) * H", "=[zdLF, zdLB, zdRF, zdRB][index % 4]"],
        },

        // ================= Windows =================
        // Units in wall-local coordinates: the wall's centre plane at z = 0, outside toward +Z, window bottom at y = 0.
        {
            id: "roomWindow", type: "object", object: "architecture.window", output: false,
            params: { width: "=ww", height: "=wh", style: "=windowStyle", panesX: "=panesX", panesY: "=panesY", arch: "=windowArch", depth: "=winDepth", sillDepth: "=tw * 0.3 + 0.04", frameWidth: 0.06, sill: true },
            at: [0, 0, "=tw * 0.1"],
        },
        {
            id: "hallWindow", type: "object", object: "architecture.window", output: false,
            params: { width: "=hwWin", height: "=wh", style: "=windowStyle", panesX: "=max(1, panesX - 1)", panesY: "=panesY", arch: "=min(windowArch, hwWin / 2, wh * 0.4)", depth: "=winDepth", sillDepth: "=tw * 0.3 + 0.04", frameWidth: 0.06, sill: true },
            at: [0, 0, "=tw * 0.1"],
        },
        { id: "roomShutterRing", type: "curve.rect", output: false, width: "=ww / 2 - 0.01", height: "=wh" },
        { id: "roomShutterHole", type: "curve.rect", output: false, width: "=ww / 2 - 0.1", height: "=wh - 0.14" },
        { id: "roomShutters", type: "mesh.extrude", output: false, when: "=shutters", repeat: 2, outline: "@roomShutterRing", holes: ["@roomShutterHole"], height: 0.035, rotate: [-90, 0, 0], at: ["=(index == 0 ? -1 : 1) * (ww * 0.75 + 0.035)", "=wh / 2", "=tw / 2 + 0.04"], region: "shutters" },
        { id: "roomLouvres", type: "mesh.box", output: false, when: "=shutters", repeat: "=2 * floor((wh - 0.14) / 0.075)", size: ["=ww / 2 - 0.1", 0.055, 0.012], rotate: [-28, 0, 0], at: ["=(index % 2 == 0 ? -1 : 1) * (ww * 0.75 + 0.035)", "=0.07 + (floor(index / 2) + 0.5) * (wh - 0.14) / floor((wh - 0.14) / 0.075)", "=tw / 2 + 0.022"], region: "shutters" },
        { id: "roomLintel", type: "mesh.box", output: false, when: "=lintels", size: ["=ww + 0.26", 0.18, 0.07], radius: 0.01, segments: 1, at: [0, "=wh + 0.09", "=tw / 2"], region: "dressing" },
        { id: "roomKeystone", type: "mesh.box", output: false, when: "=lintels", size: [0.17, 0.27, 0.1], radius: 0.01, segments: 1, at: [0, "=wh + 0.11", "=tw / 2 + 0.01"], region: "dressing" },
        { id: "roomUnit", type: "geo.join", output: false, meshes: ["@roomWindow", "@roomShutters", "@roomLouvres", "@roomLintel", "@roomKeystone"] },
        { id: "hallShutterRing", type: "curve.rect", output: false, width: "=hwWin / 2 - 0.01", height: "=wh" },
        { id: "hallShutterHole", type: "curve.rect", output: false, width: "=hwWin / 2 - 0.1", height: "=wh - 0.14" },
        { id: "hallShutters", type: "mesh.extrude", output: false, when: "=shutters", repeat: 2, outline: "@hallShutterRing", holes: ["@hallShutterHole"], height: 0.035, rotate: [-90, 0, 0], at: ["=(index == 0 ? -1 : 1) * (hwWin * 0.75 + 0.035)", "=wh / 2", "=tw / 2 + 0.04"], region: "shutters" },
        { id: "hallLouvres", type: "mesh.box", output: false, when: "=shutters", repeat: "=2 * floor((wh - 0.14) / 0.075)", size: ["=hwWin / 2 - 0.1", 0.055, 0.012], rotate: [-28, 0, 0], at: ["=(index % 2 == 0 ? -1 : 1) * (hwWin * 0.75 + 0.035)", "=0.07 + (floor(index / 2) + 0.5) * (wh - 0.14) / floor((wh - 0.14) / 0.075)", "=tw / 2 + 0.022"], region: "shutters" },
        { id: "hallLintel", type: "mesh.box", output: false, when: "=lintels", size: ["=hwWin + 0.26", 0.18, 0.07], radius: 0.01, segments: 1, at: [0, "=wh + 0.09", "=tw / 2"], region: "dressing" },
        { id: "hallKeystone", type: "mesh.box", output: false, when: "=lintels", size: [0.17, 0.27, 0.1], radius: 0.01, segments: 1, at: [0, "=wh + 0.11", "=tw / 2 + 0.01"], region: "dressing" },
        { id: "hallUnit", type: "geo.join", output: false, meshes: ["@hallWindow", "@hallShutters", "@hallLouvres", "@hallLintel", "@hallKeystone"] },
        {
            id: "frontWindows", type: "geo.transform", repeat: "=shownN * kRow", mesh: "@roomUnit",
            at: ["=index % kRow < kL ? cL + (index % kRow - (kL - 1) / 2) * pitchW : cR + (index % kRow - kL - (kR - 1) / 2) * pitchW", "=pl + floor(index / kRow) * H + sh", "=D2 - tw / 2"],
        },
        {
            id: "backWindows", type: "geo.transform", repeat: "=shownN * kRow", mesh: "@roomUnit", rotate: [0, 180, 0],
            at: ["=index % kRow < kL ? cL + (index % kRow - (kL - 1) / 2) * pitchW : cR + (index % kRow - kL - (kR - 1) / 2) * pitchW", "=pl + floor(index / kRow) * H + sh", "=-D2 + tw / 2"],
        },
        { id: "hallFrontWindows", type: "geo.transform", repeat: "=shownN - 1", mesh: "@hallUnit", at: ["=hallX", "=pl + (index + 1) * H + sh", "=D2 - tw / 2"] },
        { id: "hallBackWindows", type: "geo.transform", repeat: "=shownN", mesh: "@hallUnit", rotate: [0, 180, 0], at: ["=hallX", "=pl + index * H + sh", "=-D2 + tw / 2"] },
        {
            // index % 2: left or right wall; then storey and window along the wall.
            id: "sideWindowUnits", type: "geo.transform", repeat: "=2 * shownN * kSide", mesh: "@roomUnit",
            rotate: [0, "=index % 2 == 0 ? -90 : 90", 0],
            at: [
                "=index % 2 == 0 ? -W2 + tw / 2 : W2 - tw / 2",
                "=pl + floor(floor(index / 2) / kSide) * H + sh",
                "=floor(index / 2) % kSide < kSF ? zmF + (floor(index / 2) % kSide - (kSF - 1) / 2) * pitchW : zmB + (floor(index / 2) % kSide - kSF - (kSB - 1) / 2) * pitchW",
            ],
        },

        // ================= Staircase =================
        // Stair f climbs from storey f; index = f * steps + k for step k.
        // Closed: risers, a string each side and a sloped soffit underneath, so stacked flights keep
        // their headroom. Open: two stringers carrying thick treads, nothing between them.
        { id: "treads", type: "mesh.box", repeat: "=stairsShown * steps", size: ["=treadW", "=treadT", "=tread + 0.03"], radius: 0.008, segments: 1, at: ["=sX", "=pl + floor(index / steps) * H + (index % steps + 1) * rh - treadT / 2", "=zS - (index % steps + 0.5) * tread + 0.015"], region: "treads" },
        { id: "risers", type: "mesh.box", when: "=stairStyle == 'closed'", repeat: "=stairsShown * steps", size: ["=stairWidth - 0.02", "=rh - treadT", 0.025], at: ["=sX", "=pl + floor(index / steps) * H + (index % steps) * rh + (rh - treadT) / 2", "=zS - (index % steps) * tread - 0.0125"], region: "stair" },
        {
            id: "soffits", type: "mesh.box", when: "=stairStyle == 'closed'", repeat: "=stairsShown", size: ["=stairWidth - 0.02", 0.03, "=(run + 0.05) / cos(slope)"], rotate: ["=deg(slope)", 0, 0],
            at: ["=sX", "=pl + index * H + rh + (zS - stringZ) * rh / tread - 0.32", "=stringZ"], region: "stair",
        },
        {
            id: "strings", type: "mesh.box", repeat: "=stairsShown * 2", size: [0.05, 0.3, "=(run + 0.05) / cos(slope)"], radius: 0.01, segments: 1,
            rotate: ["=deg(slope)", 0, 0],
            at: [
                "=stairStyle == 'open' ? (index % 2 == 0 ? sOut - sgn * 0.04 : sIn + sgn * 0.04) : (index % 2 == 0 ? sOut - sgn * 0.025 : sIn - sgn * 0.025)",
                "=pl + floor(index / 2) * H + rh + (zS - stringZ) * rh / tread - 0.14",
                "=stringZ",
            ],
            region: "=stairStyle == 'open' ? 'treads' : 'stair'",
        },
        { id: "newels", type: "mesh.box", repeat: "=stairsShown * 2", size: [0.1, "=index % 2 == 0 ? rh + 1.0 : H + 1.05", 0.1], radius: 0.01, segments: 1, at: ["=sIn", "=pl + floor(index / 2) * H + (index % 2 == 0 ? (rh + 1.0) / 2 : (H + 1.05) / 2)", "=index % 2 == 0 ? zS - tread / 2 : zE - 0.05"], region: "treads" },
        { id: "newelCaps", type: "mesh.sphere", repeat: "=stairsShown * 2", radius: 0.065, segments: 14, rings: 7, at: ["=sIn", "=pl + floor(index / 2) * H + (index % 2 == 0 ? rh + 1.04 : H + 1.09)", "=index % 2 == 0 ? zS - tread / 2 : zE - 0.05"], region: "treads" },
        { id: "handrails", type: "mesh.box", repeat: "=stairsShown", size: [0.065, 0.055, "=(run - tread) / cos(slope)"], radius: 0.022, segments: 2, rotate: ["=deg(slope)", 0, 0], at: ["=xRail", "=pl + index * H + rh + 0.92 + (steps - 1) * rh / 2", "=zS - tread / 2 - (run - tread) / 2"], region: "treads" },
        {
            id: "stairBalusters", type: "mesh.box", repeat: "=stairsShown * steps * balusters", size: [0.034, "=0.89 + ((index % balusters + 0.5) / balusters - 0.5) * rh", 0.034],
            at: [
                "=xRail",
                "=pl + floor(index / (steps * balusters)) * H + (floor((index % (steps * balusters)) / balusters) + 1) * rh + (0.89 + ((index % balusters + 0.5) / balusters - 0.5) * rh) / 2",
                "=zS - (floor((index % (steps * balusters)) / balusters) + (index % balusters + 0.5) / balusters) * tread",
            ],
            region: "stair",
        },
        // Guard around the stairwell on the storey above: along the open side and across the foot.
        // The long side runs on every storey above a flight; the end rail across the stair's foot only
        // where no further flight starts (it would block it).
        { id: "guardRails", type: "mesh.box", repeat: "=guardsShown", size: [0.065, 0.055, "=run + 0.05"], radius: 0.022, segments: 2, at: ["=xGuard", "=pl + (index + 1) * H + 0.97", "=(zS + zE) / 2 - 0.02"], region: "treads" },
        { id: "guardBalusters", type: "mesh.box", repeat: "=guardsShown * nGuard", size: [0.034, 0.95, 0.034], at: ["=xGuard", "=pl + (floor(index / nGuard) + 1) * H + 0.475", "=zE + (index % nGuard + 0.5) * run / nGuard"], region: "stair" },
        { id: "endRails", type: "mesh.box", repeat: "=endGuards", size: ["=stairWidth + 0.05", 0.055, 0.065], radius: 0.022, segments: 2, at: ["=sX - sgn * 0.03", "=pl + (guardsShown - endGuards + 1 + index) * H + 0.97", "=zS + 0.045"], region: "treads" },
        { id: "endPosts", type: "mesh.box", repeat: "=endGuards", size: [0.1, 1.05, 0.1], radius: 0.01, segments: 1, at: ["=sIn", "=pl + (guardsShown - endGuards + 1 + index) * H + 0.525", "=zS + 0.045"], region: "treads" },
        { id: "endBalusters", type: "mesh.box", repeat: "=endGuards * nGuardEnd", size: [0.034, 0.95, 0.034], at: ["=sIn + sgn * (index % nGuardEnd + 0.5) * stairWidth / nGuardEnd", "=pl + (guardsShown - endGuards + 1 + floor(index / nGuardEnd)) * H + 0.475", "=zS + 0.045"], region: "stair" },

        // ================= Porch, stoop and steps =================
        { id: "porchDeck", type: "mesh.box", size: ["=hasPorch ? porchW : dwo + 0.9", "=pl - 0.06", "=pd"], at: ["=hasPorch ? porchX : hallX", "=(pl - 0.06) / 2", "=D2 + pd / 2"], region: "foundation" },
        { id: "porchFloor", type: "mesh.box", size: ["=(hasPorch ? porchW : dwo + 0.9) + 0.06", 0.06, "=pd + 0.05"], radius: 0.01, segments: 1, at: ["=hasPorch ? porchX : hallX", "=pl - 0.03", "=D2 + pd / 2 + 0.005"], region: "dressing" },
        { id: "frontSteps", type: "mesh.box", repeat: "=nSteps - 1", size: ["=stepW", "=pl - (index + 1) * stepRise", "=(index + 1) * 0.3"], radius: 0.006, segments: 1, at: ["=stepX", "=(pl - (index + 1) * stepRise) / 2", "=zPorchFront + (index + 1) * 0.15"], region: "dressing" },
        // Turned columns: base, entasis shaft, capital.
        {
            id: "columnProfile", type: "curve.points", output: false,
            points: [[0, 0], [0.19, 0], [0.19, 0.09], [0.155, 0.13], [0.125, 0.2], [0.11, "=colH - 0.3"], [0.125, "=colH - 0.2"], [0.165, "=colH - 0.1"], [0.19, "=colH - 0.1"], [0.19, "=colH"], [0, "=colH"]],
        },
        { id: "turnedColumn", type: "mesh.lathe", output: false, profile: "@columnProfile", segments: 18, smoothAngle: 50 },
        { id: "squarePost", type: "mesh.box", output: false, size: [0.2, "=colH", 0.2], radius: 0.012, segments: 1, at: [0, "=colH / 2", 0] },
        {
            id: "columns", type: "geo.transform", when: "=hasPorch", repeat: "=porch == 'veranda' ? nBays + 1 : 4", mesh: { if: "=porchPosts == 'square'", then: "@squarePost", else: "@turnedColumn" },
            at: ["=porch == 'veranda' ? -W2 + 0.25 + index * bay : porchX + (index % 2 == 0 ? -1 : 1) * (porchW / 2 - 0.25)", "=pl", "=porch == 'veranda' || index < 2 ? zPorchFront - 0.25 : D2 + 0.25"],
            region: "trim",
        },
        { id: "porchBeam", type: "mesh.box", when: "=hasPorch", size: ["=porchW + 0.1", 0.26, 0.32], radius: 0.01, segments: 1, at: ["=porchX", "=yb + 0.13", "=zPorchFront - 0.25"], region: "trim" },
        { id: "porchSideBeams", type: "mesh.box", when: "=porch == 'portico'", repeat: 2, size: [0.32, 0.26, "=pd"], radius: 0.01, segments: 1, at: ["=porchX + (index == 0 ? -1 : 1) * (porchW / 2 - 0.25)", "=yb + 0.13", "=D2 + pd / 2"], region: "trim" },
        // Portico: a pediment roof over the door. Veranda: a shed roof along the whole front.
        { id: "pedProfile", type: "curve.points", output: false, closed: true, points: [["=pedEave", 0], ["=pedEave", 0.14], [0, "=pedRise + 0.14"], ["=-pedEave", 0.14], ["=-pedEave", 0], [0, "=pedRise"]] },
        { id: "porticoRoof", type: "mesh.extrude", when: "=porch == 'portico' && roofStyle != 'flat'", outline: "@pedProfile", height: "=pd + 0.2", rotate: [-90, 0, 0], at: ["=porchX", "=yb + 0.26", "=zPorchFront + 0.2"], region: "roof" },
        { id: "tympanum", type: "curve.points", output: false, closed: true, points: [["=-pedEave + 0.18", 0], ["=pedEave - 0.18", 0], [0, "=pedRise - 0.1"]] },
        { id: "pediment", type: "mesh.extrude", when: "=porch == 'portico' && roofStyle != 'flat' && pedRise > 0.3", outline: "@tympanum", height: 0.1, rotate: [-90, 0, 0], at: ["=porchX", "=yb + 0.26", "=zPorchFront + 0.02"], region: "trim" },
        // A flat-roofed house gets a flat canopy instead of a pediment.
        { id: "canopy", type: "mesh.box", when: "=porch == 'portico' && roofStyle == 'flat'", size: ["=porchW + 0.4", 0.22, "=pd + 0.3"], radius: 0.01, segments: 1, at: ["=porchX", "=yb + 0.37", "=D2 + (pd + 0.3) / 2"], region: "trim" },
        { id: "canopyTop", type: "mesh.box", when: "=porch == 'portico' && roofStyle == 'flat'", size: ["=porchW + 0.3", 0.02, "=pd + 0.2"], at: ["=porchX", "=yb + 0.49", "=D2 + (pd + 0.2) / 2"], region: "roof" },
        { id: "porchCeiling", type: "mesh.box", when: "=porch == 'portico'", size: ["=porchW", 0.03, "=pd"], at: ["=porchX", "=yb + 0.275", "=D2 + pd / 2"], region: "trim" },
        { id: "shedProfile", type: "curve.points", output: false, closed: true, points: [["=D2", "=shedHigh"], ["=zPorchFront + 0.3", "=yb + 0.26 - 0.4 * shedSlope"], ["=zPorchFront + 0.3", "=yb + 0.26 - 0.4 * shedSlope + 0.14"], ["=D2", "=shedHigh + 0.14"]] },
        { id: "verandaRoof", type: "mesh.extrude", when: "=porch == 'veranda'", outline: "@shedProfile", height: "=width + 0.2", rotate: [-90, -90, 0], at: ["=-W2 - 0.1", 0, 0], region: "roof" },
        // Veranda railings in every bay but the one with the steps, and along both ends.
        { id: "railTops", type: "mesh.box", when: "=porch == 'veranda'", repeat: "=2 * (nBays - 1)", size: ["=bay - 0.3", 0.06, 0.08], radius: 0.015, segments: 1, at: ["=-W2 + 0.25 + ((floor(index / 2) < stepBay ? floor(index / 2) : floor(index / 2) + 1) + 0.5) * bay", "=pl + (index % 2 == 0 ? 0.9 : 0.1)", "=zPorchFront - 0.25"], region: "trim" },
        { id: "railBalusters", type: "mesh.box", when: "=porch == 'veranda'", repeat: "=(nBays - 1) * nBal", size: [0.04, 0.74, 0.04], at: ["=-W2 + 0.25 + (floor(index / nBal) < stepBay ? floor(index / nBal) : floor(index / nBal) + 1) * bay + 0.15 + (index % nBal + 0.5) * (bay - 0.3) / nBal", "=pl + 0.5", "=zPorchFront - 0.25"], region: "trim" },
        { id: "verandaEndRails", type: "mesh.box", when: "=porch == 'veranda'", repeat: 4, size: [0.08, 0.06, "=pd - 0.5"], radius: 0.015, segments: 1, at: ["=(index % 2 == 0 ? -1 : 1) * (W2 - 0.25)", "=pl + (index < 2 ? 0.9 : 0.1)", "=D2 + (pd - 0.5) / 2 + 0.05"], region: "trim" },
        { id: "verandaEndBalusters", type: "mesh.box", when: "=porch == 'veranda'", repeat: "=2 * nSideBal", size: [0.04, 0.74, 0.04], at: ["=(index % 2 == 0 ? -1 : 1) * (W2 - 0.25)", "=pl + 0.5", "=D2 + 0.05 + (floor(index / 2) + 0.5) * (pd - 0.5) / nSideBal"], region: "trim" },

        // ================= Exterior details =================
        { id: "belts", type: "mesh.box", when: "=beltCourse", repeat: "=4 * (shownN - 1)", size: ["=index % 4 < 2 ? width + 0.06 : 0.06", 0.16, "=index % 4 < 2 ? 0.06 : depth + 0.06"], at: ["=index % 4 < 2 ? 0 : (index % 4 == 2 ? -1 : 1) * W2", "=pl + (floor(index / 4) + 1) * H - 0.12", "=index % 4 < 2 ? (index % 4 == 0 ? -1 : 1) * D2 : 0"], region: "dressing" },
        { id: "cornerBoards", type: "mesh.box", when: "=corners == 'boards'", repeat: 4, size: [0.24, "=shownN * H", 0.24], at: ["=(index % 2 == 0 ? -1 : 1) * (W2 - 0.105)", "=pl + shownN * H / 2", "=(index < 2 ? -1 : 1) * (D2 - 0.105)"], region: "trim" },
        {
            id: "quoins", type: "mesh.box", when: "=corners == 'quoins'", repeat: "=4 * nQuoins", radius: 0.012, segments: 1,
            size: ["=(floor(index / 4) % 2 == 0 ? 0.52 : 0.3)", 0.28, "=(floor(index / 4) % 2 == 0 ? 0.3 : 0.52)"],
            at: ["=(index % 2 == 0 ? -1 : 1) * (W2 + 0.02 - (floor(index / 4) % 2 == 0 ? 0.26 : 0.15))", "=pl + 0.02 + (floor(index / 4) + 0.5) * 0.32", "=(index % 4 < 2 ? -1 : 1) * (D2 + 0.02 - (floor(index / 4) % 2 == 0 ? 0.15 : 0.26))"],
            region: "dressing",
        },

        // ================= Roof =================
        // Gable: a chevron shell whose underside passes through the walls' top outer edges.
        { id: "gableProfile", type: "curve.points", output: false, closed: true, points: [["=hb", "=yEave"], ["=hb", "=yEave + k"], [0, "=yRidge + k"], ["=-hb", "=yEave + k"], ["=-hb", "=yEave"], [0, "=yRidge"]] },
        { id: "gableRoof", type: "mesh.extrude", when: "=roofShown && roofStyle == 'gable'", outline: "@gableProfile", height: "=width + 2 * o", rotate: [-90, -90, 0], at: ["=-ha", 0, 0], region: "roof" },
        { id: "gableWinHoleShape", type: "curve.arch", output: false, width: "=gww - 0.004", height: "=gwh - 0.004", rise: "=gArch", segments: 20 },
        { id: "gableWinHole", type: "curve.transform", output: false, curve: "@gableWinHoleShape", offset: [0, 0.352] },
        { id: "gableTriangle", type: "curve.points", output: false, closed: true, points: [["=-D2", 0], ["=D2", 0], [0, "=D2 * tp"]] },
        { id: "gableEnds", type: "mesh.extrude", when: "=roofShown && roofStyle == 'gable'", repeat: 2, outline: "@gableTriangle", holes: { if: "=hasGableWin", then: ["@gableWinHole"], else: [] }, height: "=tw", rotate: [-90, -90, 0], at: ["=index == 0 ? -W2 : W2 - tw", "=yTop", 0], region: "exterior" },
        { id: "gableWindowObj", type: "object", when: "=roofShown && hasGableWin", object: "architecture.window", output: false, params: { width: "=gww", height: "=gwh", arch: "=gArch", style: "fixed", panesX: 2, panesY: 2, depth: "=winDepth", sill: true, sillDepth: "=tw * 0.3 + 0.04", frameWidth: 0.06 } },
        { id: "gableWindows", type: "geo.transform", when: "=roofShown && hasGableWin", repeat: 2, mesh: "@gableWindowObj", rotate: [0, "=index == 0 ? -90 : 90", 0], at: ["=(index == 0 ? -1 : 1) * (W2 - tw / 2 + tw * 0.1)", "=yTop + 0.35", 0] },
        { id: "bargeBoards", type: "mesh.box", when: "=roofShown && roofStyle == 'gable'", repeat: 4, size: [0.05, "=k + 0.12", "=hb / cos(rad(pitch)) + 0.02"], at: ["=(index % 2 == 0 ? -1 : 1) * (ha + 0.025)", "=yTop + (D2 - hb / 2) * tp + k / 2 - 0.04", "=(index < 2 ? 1 : -1) * hb / 2"], rotate: ["=(index < 2 ? 1 : -1) * pitch", 0, 0], region: "trim" },
        { id: "fascias", type: "mesh.box", when: "=roofShown && roofStyle == 'gable'", repeat: 2, size: ["=width + 2 * o + 0.1", "=k + 0.08", 0.05], at: [0, "=yEave + k / 2 - 0.02", "=(index == 0 ? 1 : -1) * (hb + 0.025)"], region: "trim" },
        { id: "ridge", type: "mesh.cylinder", when: "=roofShown && roofStyle == 'gable'", radius: 0.08, height: "=width + 2 * o + 0.06", segments: 12, rotate: [0, 0, -90], at: ["=-ha - 0.03", "=yRidge + k - 0.03", 0], region: "roof" },
        // Hip: a boxed eave and a lofted roof whose ridge runs along the longer side.
        { id: "hipEave", type: "mesh.box", when: "=roofShown && roofStyle == 'hip'", size: ["=2 * ha + 0.06", 0.2, "=2 * hb + 0.06"], at: [0, "=hipBase - 0.1", 0], region: "trim" },
        { id: "hipBottom", type: "curve.points", output: false, closed: true, points: [["=-ha", "=-hb"], ["=ha", "=-hb"], ["=ha", "=hb"], ["=-ha", "=hb"]] },
        { id: "hipTop", type: "curve.points", output: false, closed: true, points: [["=-max(ha - hb, 0.02)", "=-max(hb - ha, 0.02)"], ["=max(ha - hb, 0.02)", "=-max(hb - ha, 0.02)"], ["=max(ha - hb, 0.02)", "=max(hb - ha, 0.02)"], ["=-max(ha - hb, 0.02)", "=max(hb - ha, 0.02)"]] },
        { id: "hipRoof", type: "mesh.loft", when: "=roofShown && roofStyle == 'hip'", bottom: "@hipBottom", top: "@hipTop", height: "=hipH", at: [0, "=hipBase", 0], region: "roof" },
        // Flat: a deep fascia slab with a membrane.
        { id: "flatRoof", type: "mesh.box", when: "=roofShown && roofStyle == 'flat'", size: ["=2 * ha", 0.3, "=2 * hb"], at: [0, "=yTop + 0.15", 0], region: "trim" },
        { id: "flatMembrane", type: "mesh.box", when: "=roofShown && roofStyle == 'flat'", size: ["=2 * ha - 0.16", 0.02, "=2 * hb - 0.16"], at: [0, "=yTop + 0.31", 0], region: "roof" },
        // Gutters and downpipes (both mirrored from the front-right one).
        { id: "gutterRuns", type: "mesh.cylinder", when: "=roofShown && gutters && roofStyle != 'flat'", repeat: "=roofStyle == 'hip' ? 4 : 2", radius: 0.07, height: "=index < 2 ? 2 * ha + 0.1 : 2 * hb + 0.1", segments: 12, rotate: ["=index < 2 ? 0 : 90", 0, "=index < 2 ? -90 : 0"], at: ["=index < 2 ? -ha - 0.05 : (index == 2 ? -1 : 1) * (ha + 0.09)", "=gutterY", "=index < 2 ? (index == 0 ? 1 : -1) * gutterZ : -hb - 0.05"], region: "gutters" },
        { id: "downpipePath", type: "path.points", output: false, fillet: 0.12, filletSegments: 4, points: [["=W2 - 0.3", 0.08, "=D2 + 0.07"], ["=W2 - 0.3", "=gutterY - 0.55", "=D2 + 0.07"], ["=W2 - 0.3", "=gutterY - 0.25", "=gutterZ"], ["=W2 - 0.3", "=gutterY", "=gutterZ"]] },
        { id: "downpipes", type: "mesh.sweep", when: "=roofShown && gutters && roofStyle != 'flat'", repeat: "=porch == 'veranda' ? 2 : 4", path: "@downpipePath", radius: 0.04, sides: 10, scale: ["=index % 2 == 0 ? 1 : -1", 1, "=porch == 'veranda' || index >= 2 ? -1 : 1"], region: "gutters" },
        // Chimneys: stack, corbelled cap and pots.
        { id: "chimneyStacks", type: "mesh.box", when: "=roofShown", repeat: "=chimneys", size: ["=cw", "=chimTop - chimBase", "=cd"], at: ["=(index == 0 ? -1 : 1) * chimX", "=(chimTop + chimBase) / 2", "=chimZ"], region: "chimney" },
        { id: "chimneyCaps", type: "mesh.box", when: "=roofShown", repeat: "=chimneys * 2", size: ["=cw + (index % 2 == 0 ? 0.14 : 0.06)", "=index % 2 == 0 ? 0.12 : 0.08", "=cd + (index % 2 == 0 ? 0.14 : 0.06)"], radius: 0.01, segments: 1, at: ["=(floor(index / 2) == 0 ? -1 : 1) * chimX", "=chimTop - (index % 2 == 0 ? 0.26 : 0.04)", "=chimZ"], region: "=index % 2 == 0 ? 'chimney' : 'dressing'" },
        { id: "chimneyPots", type: "mesh.cone", when: "=roofShown", repeat: "=chimneys * 2", bottomRadius: 0.11, topRadius: 0.09, height: 0.38, segments: 14, bevel: 0.01, at: ["=(floor(index / 2) == 0 ? -1 : 1) * chimX + (index % 2 == 0 ? -0.2 : 0.2)", "=chimTop", "=chimZ"], region: "pots" },
        // Dormers: a front wall with the window hole, a gable roof and a gable infill, built once and placed.
        { id: "dormerFront", type: "curve.points", output: false, closed: true, points: [["=-dW / 2", 0], ["=dW / 2", 0], ["=dW / 2", "=dH"], ["=-dW / 2", "=dH"]] },
        { id: "dormerHoleShape", type: "curve.arch", output: false, width: "=dww - 0.004", height: "=dwh - 0.004", rise: "=min(windowArch, dww / 2, dwh * 0.4)", segments: 20 },
        { id: "dormerHole", type: "curve.transform", output: false, curve: "@dormerHoleShape", offset: [0, 0.222] },
        { id: "dormerBody", when: "=nDormers > 0", type: "mesh.extrude", output: false, outline: "@dormerFront", holes: ["@dormerHole"], height: "=dLen", rotate: [-90, 0, 0], at: [0, 0, 0], region: "exterior" },
        { id: "dormerGableShape", type: "curve.points", output: false, closed: true, points: [["=-dW / 2", "=dH"], ["=dW / 2", "=dH"], [0, "=dH + dW / 2 * dtp"]] },
        { id: "dormerGable", when: "=nDormers > 0", type: "mesh.extrude", output: false, outline: "@dormerGableShape", height: "=dLen", rotate: [-90, 0, 0], region: "exterior" },
        { id: "dormerRoofShape", type: "curve.points", output: false, closed: true, points: [["=dW / 2 + 0.14", "=dH - 0.14 * dtp"], ["=dW / 2 + 0.14", "=dH - 0.14 * dtp + dk"], [0, "=dH + dW / 2 * dtp + dk"], ["=-dW / 2 - 0.14", "=dH - 0.14 * dtp + dk"], ["=-dW / 2 - 0.14", "=dH - 0.14 * dtp"], [0, "=dH + dW / 2 * dtp"]] },
        { id: "dormerRoof", when: "=nDormers > 0", type: "mesh.extrude", output: false, outline: "@dormerRoofShape", height: "=dLen + 0.15", rotate: [-90, 0, 0], at: [0, 0, 0.15], region: "roof" },
        { id: "dormerFascia", when: "=nDormers > 0", type: "mesh.box", output: false, repeat: 2, size: ["=(dW / 2 + 0.14) / cos(rad(50)) + 0.02", "=dk + 0.08", 0.04], rotate: [0, 0, "=(index == 0 ? 1 : -1) * 50"], at: ["=(index == 0 ? -1 : 1) * (dW / 4 + 0.07)", "=dH + (dW / 4 - 0.07) * dtp + dk / 2 - 0.02", 0.17], region: "trim" },
        { id: "dormerWindow", type: "object", when: "=nDormers > 0", object: "architecture.window", output: false, params: { width: "=dww", height: "=dwh", style: "=windowStyle == 'sash' ? 'casement' : windowStyle", panesX: "=max(1, panesX)", panesY: "=max(1, panesY - 1)", arch: "=min(windowArch, dww / 2, dwh * 0.4)", depth: 0.08, sill: true, sillDepth: 0.05, frameWidth: 0.05 }, at: [0, 0.22, -0.08] },
        { id: "dormerUnit", type: "geo.join", output: false, meshes: ["@dormerBody", "@dormerGable", "@dormerRoof", "@dormerFascia", "@dormerWindow"] },
        { id: "dormerPlacements", type: "geo.transform", repeat: "=nDormers", mesh: "@dormerUnit", at: ["=(index - (count - 1) / 2) * dPitch", "=yd0", "=dzf"] },
    ],
    limits: { maxSize: 32, minSize: 5, maxTriangles: 450000 },
};

export default houseDef;
