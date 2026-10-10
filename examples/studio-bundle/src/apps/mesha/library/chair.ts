import type { ObjectDef } from "../mesha_object";

/**
 * Four-legged seating, from a cafe stool to a park bench: a solid or slatted seat on splayed legs
 * (component.leg) with stretchers, and a back of ladder rails, vertical slats, spindles, a panel or
 * upholstery that curves round the sitter and reclines. The back's posts stand over the rear legs;
 * a curved back is sized so its ends still meet them. Faces +Z.
 */
const chair: ObjectDef = {
    id: "furniture.chair",
    name: "Chair, Stool & Bench",
    category: "Furniture",
    tags: ["chair", "dining chair", "kitchen chair", "stool", "bar stool", "bench", "park bench", "windsor", "ladder back", "seat", "seating"],
    description: "Dining chairs, stools and benches: seat, legs, stretchers, back and arms.",
    featured: ["seats", "seatHeight", "seatShape", "backStyle", "backHeight", "legStyle", "stretchers", "arms", "frameFinish", "seatFinish"],
    groups: [
        { id: "seat", label: "Seat" },
        { id: "back", label: "Back and arms" },
        { id: "legs", label: "Legs" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "seats", label: "Seats", type: "int", default: 1, min: 1, max: 5, group: "seat", description: "Places side by side: more than one makes a bench." },
        { id: "seatWidth", label: "Seat width", type: "number", default: 0.44, min: 0.28, max: 0.65, unit: "m", group: "seat", description: "Per place; a round seat's diameter." },
        { id: "seatDepth", label: "Seat depth", type: "number", default: 0.42, min: 0.26, max: 0.6, unit: "m", group: "seat", visibleIf: "=!isRound" },
        { id: "seatHeight", label: "Seat height", type: "number", default: 0.46, min: 0.3, max: 0.85, unit: "m", group: "seat" },
        { id: "seatShape", label: "Seat shape", type: "enum", default: "rounded", options: ["rectangle", "rounded", "round"], optionLabels: ["Rectangle", "Rounded", "Round"], group: "seat" },
        { id: "seatStyle", label: "Seat", type: "enum", default: "solid", options: ["solid", "slatted"], optionLabels: ["Solid", "Slatted"], group: "seat", visibleIf: "=!isRound" },
        { id: "seatThickness", label: "Seat thickness", type: "number", default: 0.03, min: 0.015, max: 0.06, unit: "m", decimals: 3, group: "seat" },
        { id: "cushion", label: "Cushion", type: "bool", default: false, group: "seat" },
        { id: "cushionThickness", label: "Cushion thickness", type: "number", default: 0.05, min: 0.02, max: 0.12, unit: "m", decimals: 3, group: "seat", visibleIf: "=cushion" },
        { id: "backStyle", label: "Back", type: "enum", default: "spindles", options: ["none", "ladder", "slats", "spindles", "panel", "upholstered"], optionLabels: ["None", "Ladder rails", "Vertical slats", "Spindles", "Panel", "Upholstered"], group: "back" },
        { id: "backHeight", label: "Back height", type: "number", default: 0.46, min: 0.12, max: 0.75, unit: "m", group: "back", visibleIf: "=backStyle != 'none'" },
        { id: "recline", label: "Recline", type: "number", default: 8, min: 0, max: 22, unit: "°", group: "back", visibleIf: "=backStyle != 'none'" },
        { id: "backCurve", label: "Back curve", type: "number", default: 20, min: 0, max: 60, unit: "°", group: "back", visibleIf: "=backStyle != 'none'" },
        { id: "rails", label: "Rails", type: "int", default: 3, min: 1, max: 6, group: "back", visibleIf: "=backStyle == 'ladder'" },
        { id: "arms", label: "Arms", type: "bool", default: false, group: "back", visibleIf: "=backStyle != 'none'" },
        { id: "armHeight", label: "Arm height", type: "number", default: 0.22, min: 0.14, max: 0.32, unit: "m", group: "back", visibleIf: "=arms && backStyle != 'none'" },
        { id: "legStyle", label: "Leg style", type: "enum", default: "turned", options: ["square", "tapered", "round", "turned"], optionLabels: ["Square", "Tapered", "Round", "Turned"], group: "legs" },
        { id: "legThickness", label: "Leg thickness", type: "number", default: 0.038, min: 0.02, max: 0.07, unit: "m", decimals: 3, group: "legs" },
        { id: "splay", label: "Splay", type: "number", default: 5, min: 0, max: 12, unit: "°", group: "legs" },
        { id: "stretchers", label: "Stretchers", type: "enum", default: "H", options: ["none", "box", "H", "footrest"], optionLabels: ["None", "Box", "H", "Footrest"], group: "legs" },
        { id: "apron", label: "Seat rails", type: "bool", default: false, group: "legs", visibleIf: "=!isRound" },
        { id: "frameFinish", label: "Frame", type: "material", default: "wood.oak", materials: ["wood", "paint", "metal.black", "metal.steel", "metal.chrome", "metal.brass"], group: "materials" },
        { id: "seatFinish", label: "Seat", type: "material", default: "wood.oak", materials: ["wood", "paint", "plastic", "leather", "metal.black"], group: "materials" },
        { id: "cushionFinish", label: "Upholstery", type: "material", default: "fabric.oatmeal", materials: ["fabric", "leather"], group: "materials", visibleIf: "=cushion || backStyle == 'upholstered'" },
        { id: "seed", label: "Seed", type: "seed", default: 5, group: "materials", variation: 0 },
    ],
    derived: {
        isRound: "=seatShape == 'round' && seats == 1",
        W: "=seatWidth * seats",
        D: "=isRound ? seatWidth : seatDepth",
        st: "=seatThickness",
        ct: "=cushion ? cushionThickness : 0",
        // The hard seat's top; a cushion brings the sitting height up to seatHeight.
        hardTop: "=seatHeight - ct * 0.7",
        legH: "=hardTop - st",
        lt: "=legThickness",
        lx: "=isRound ? W / 2 * 0.6 : W / 2 - lt / 2 - 0.02",
        lz: "=isRound ? D / 2 * 0.6 : D / 2 - lt / 2 - 0.02",
        nLegs: "=seats >= 3 ? 6 : 4",
        sa: "=rad(splay)",
        spread: "=legH * tan(sa)",
        strY: "=stretchers == 'footrest' ? clamp(seatHeight - 0.47, legH * 0.25, legH * 0.55) : legH * 0.22",
        // A leg's distance out from the seat centre at height y (it splays out toward the floor).
        sxAt: "=lx + spread * (1 - strY / legH)",
        szAt: "=lz + spread * (1 - strY / legH)",
        rr: "=lt * 0.3",
        hasBack: "=backStyle != 'none'",
        postT: "=lt * 0.85",
        bx: "=lx",
        // The back bends round the sitter; its width is chosen so the bent ends land on the posts.
        ar: "=rad(max(backCurve, 0.5))",
        bendW: "=bx * ar / sin(ar / 2)",
        rb: "=bendW / ar",
        zEnd: "=rb * (1 - cos(ar / 2))",
        crestH: "=clamp(backHeight * 0.18, 0.045, 0.09)",
        lowRail: "=clamp(backHeight * 0.22, 0.05, 0.14)",
        nSlats: "=clamp(round(bendW / 0.085), 2, 24)",
        nSpindles: "=clamp(round(bendW / 0.055), 3, 40)",
        nSeatSlats: "=clamp(round(D / 0.065), 3, 9)",
        armT: "=clamp(lt * 1.3, 0.035, 0.07)",
        armBack: "=-lz - armHeight * tan(rad(recline))",
    },
    rules: [
        { check: "=lx > lt * 1.2 && lz > lt * 1.2", message: "The legs crowd together under so small a seat." },
        { check: "=legH > 0.18", message: "The seat is too low for its legs." },
        { check: "=!hasBack || seatHeight + backHeight < 1.35", message: "The back towers over the seat." },
        { check: "=!(stretchers == 'footrest') || seatHeight > 0.58", message: "A footrest belongs on a tall stool." },
        { check: "=!arms || !hasBack || backHeight > armHeight + 0.05", message: "The arms stand above the back." },
    ],
    regions: {
        frame: { label: "Frame", material: "=frameFinish" },
        seat: { label: "Seat", material: "=seatFinish" },
        cushion: { label: "Upholstery", material: "=cushionFinish" },
    },
    presets: [
        { name: "Windsor chair", values: { seats: 1, seatWidth: 0.46, seatDepth: 0.42, seatHeight: 0.45, seatShape: "rounded", seatThickness: 0.04, backStyle: "spindles", backHeight: 0.5, recline: 10, backCurve: 34, legStyle: "turned", legThickness: 0.038, splay: 7, stretchers: "H", frameFinish: "wood.oak", seatFinish: "wood.oak" } },
        { name: "Ladder-back farmhouse", values: { seats: 1, seatWidth: 0.45, seatDepth: 0.42, seatHeight: 0.46, seatShape: "rectangle", backStyle: "ladder", rails: 4, backHeight: 0.55, recline: 6, backCurve: 18, legStyle: "square", legThickness: 0.036, splay: 0, stretchers: "box", apron: true, cushion: true, cushionThickness: 0.04, frameFinish: "paint.black", seatFinish: "paint.black", cushionFinish: "fabric.rust" } },
        { name: "Cafe bar stool", values: { seats: 1, seatWidth: 0.36, seatHeight: 0.76, seatShape: "round", seatThickness: 0.035, backStyle: "none", legStyle: "round", legThickness: 0.03, splay: 8, stretchers: "footrest", frameFinish: "metal.black", seatFinish: "wood.walnut" } },
        { name: "Park bench", values: { seats: 3, seatWidth: 0.55, seatDepth: 0.45, seatHeight: 0.44, seatShape: "rectangle", seatStyle: "slatted", seatThickness: 0.03, backStyle: "ladder", rails: 3, backHeight: 0.42, recline: 14, backCurve: 0, arms: true, armHeight: 0.22, legStyle: "square", legThickness: 0.06, splay: 0, stretchers: "H", frameFinish: "metal.black", seatFinish: "wood.teak" } },
        { name: "Upholstered dining", values: { seats: 1, seatWidth: 0.48, seatDepth: 0.48, seatHeight: 0.48, seatShape: "rounded", backStyle: "upholstered", backHeight: 0.5, recline: 8, backCurve: 16, cushion: true, cushionThickness: 0.06, legStyle: "tapered", legThickness: 0.04, splay: 3, stretchers: "none", apron: true, frameFinish: "wood.walnut", seatFinish: "wood.walnut", cushionFinish: "fabric.olive" } },
        { name: "Kitchen stool", values: { seats: 1, seatWidth: 0.34, seatDepth: 0.34, seatHeight: 0.64, seatShape: "rounded", backStyle: "none", legStyle: "tapered", legThickness: 0.034, splay: 6, stretchers: "footrest", frameFinish: "wood.ash", seatFinish: "paint.sage" } },
        { name: "Mid-century panel chair", values: { seats: 1, seatWidth: 0.47, seatDepth: 0.45, seatHeight: 0.45, seatShape: "rounded", backStyle: "panel", backHeight: 0.36, recline: 14, backCurve: 40, legStyle: "tapered", legThickness: 0.034, splay: 9, stretchers: "none", frameFinish: "wood.walnut", seatFinish: "wood.walnut" } },
    ],
    nodes: [
        // --- Seat ----------------------------------------------------------------------------------
        { id: "seatRect", type: "curve.rect", output: false, width: "=W", height: "=D", radius: "=seatShape == 'rounded' ? min(0.06, D * 0.2) : 0.006", cornerSegments: 6 },
        { id: "seatCircle", type: "curve.circle", output: false, radius: "=W / 2", segments: 48 },
        { id: "seatSolid", type: "mesh.extrude", when: "=isRound || seatStyle == 'solid'", outline: { if: "=isRound", then: "@seatCircle", else: "@seatRect" }, height: "=st", bevel: "=st * 0.3", bevelSegments: 3, at: [0, "=hardTop - st", 0], region: "seat" },
        // Slatted: boards across the width with gaps, on two cross bearers.
        { id: "seatSlats", type: "mesh.box", when: "=!isRound && seatStyle == 'slatted'", repeat: "=nSeatSlats", size: ["=W", "=st * 0.7", "=D / nSeatSlats - 0.012"], radius: 0.004, at: [0, "=hardTop - st * 0.35", "=-D / 2 + (index + 0.5) * D / nSeatSlats"], region: "seat" },
        { id: "bearers", type: "mesh.box", when: "=!isRound && seatStyle == 'slatted'", repeat: "=nLegs / 2", size: ["=lt", "=st * 0.6", "=D - 0.02"], at: ["=nLegs == 6 && index == 2 ? 0 : (index * 2 - 1) * lx", "=hardTop - st * 0.7 - st * 0.3", 0], region: "frame" },
        { id: "cushionPad", type: "mesh.box", when: "=cushion && !isRound", size: ["=W - 0.02", "=ct", "=D - 0.02"], radius: "=ct * 0.45", segments: 4, at: [0, "=hardTop + ct / 2", 0.004], region: "cushion" },
        { id: "cushionRound", type: "mesh.cylinder", when: "=cushion && isRound", radius: "=W / 2 - 0.01", height: "=ct", segments: 40, bevel: "=ct * 0.45", bevelSegments: 4, at: [0, "=hardTop", 0], region: "cushion" },
        // --- Legs, splayed out at the feet; benches get a middle pair ---------------------------
        {
            id: "legs", type: "object", object: "component.leg", repeat: "=nLegs", region: "frame", rest: true,
            params: { height: "=legH / cos(sa) + 0.004", thickness: "=lt", style: "=legStyle", taper: 0.62 },
            at: [
                "=index < 4 ? (index % 2 * 2 - 1) * (lx + spread) : 0",
                0,
                "=((index < 4 ? floor(index / 2) : index - 4) * 2 - 1) * (lz + spread)",
            ],
            rotate: ["=-((index < 4 ? floor(index / 2) : index - 4) * 2 - 1) * splay", 0, "=index < 4 ? (index % 2 * 2 - 1) * splay : 0"],
        },
        // Seat rails under the seat, between the legs.
        { id: "apronX", type: "mesh.box", when: "=apron && !isRound", repeat: 2, size: ["=2 * lx", "=min(0.07, legH * 0.18)", "=lt * 0.5"], at: [0, "=legH - min(0.07, legH * 0.18) / 2", "=(index * 2 - 1) * lz"], region: "frame" },
        { id: "apronZ", type: "mesh.box", when: "=apron && !isRound", repeat: 2, size: ["=lt * 0.5", "=min(0.07, legH * 0.18)", "=2 * lz"], at: ["=(index * 2 - 1) * lx", "=legH - min(0.07, legH * 0.18) / 2", 0], region: "frame" },
        // Stretchers: rails between the legs at the height where the legs have splayed to.
        { id: "strSide", type: "mesh.cylinder", when: "=stretchers != 'none'", repeat: 2, radius: "=rr", height: "=2 * szAt", segments: 14, rotate: [90, 0, 0], at: ["=(index * 2 - 1) * sxAt", "=strY", "=-szAt"], region: "frame" },
        { id: "strFront", type: "mesh.cylinder", when: "=stretchers == 'box' || stretchers == 'footrest'", repeat: 2, radius: "=stretchers == 'footrest' && index == 1 ? rr * 1.25 : rr", height: "=2 * sxAt", segments: 14, rotate: [0, 0, -90], at: ["=-sxAt", "=strY", "=(index * 2 - 1) * szAt"], region: "frame" },
        { id: "strMid", type: "mesh.cylinder", when: "=stretchers == 'H'", radius: "=rr", height: "=2 * sxAt", segments: 14, rotate: [0, 0, -90], at: ["=-sxAt", "=strY + rr * 0.5", 0], region: "frame" },
        // --- Back, built standing on the seat at the rear legs (posts at x = ±bx, z = 0) --------
        { id: "posts", type: "mesh.box", output: false, when: "=hasBack", repeat: 2, size: ["=postT", "=backHeight + st", "=postT"], radius: "=postT * 0.3", segments: 2, at: ["=(index * 2 - 1) * bx", "=(backHeight - st) / 2", 0], region: "frame" },
        { id: "railBox", type: "mesh.box", output: false, size: ["=bendW", "=crestH", "=postT * 0.55"], radius: 0.006, divisions: [24, 1, 1] },
        { id: "rail", type: "deform.bend", output: false, mesh: "@railBox", angle: "=max(backCurve, 0.5)", width: "=bendW" },
        { id: "ladderRails", type: "geo.transform", output: false, when: "=backStyle == 'ladder'", repeat: "=rails", mesh: "@rail", at: [0, "=backHeight - crestH / 2 - index * (count > 1 ? (backHeight * 0.66 - crestH) / (count - 1) : 0)", "=-zEnd"], region: "frame" },
        { id: "crestRail", type: "geo.transform", output: false, when: "=backStyle == 'slats' || backStyle == 'spindles'", mesh: "@rail", at: [0, "=backHeight - crestH / 2", "=-zEnd"], region: "frame" },
        { id: "lowerRail", type: "geo.transform", output: false, when: "=backStyle == 'slats'", mesh: "@rail", scale: [1, 0.8, 1], at: [0, "=lowRail", "=-zEnd"], region: "frame" },
        // Vertical slats and spindles follow the curve of the rails.
        {
            id: "slats", type: "mesh.box", output: false, when: "=backStyle == 'slats'", repeat: "=nSlats", size: ["=bendW / nSlats * 0.5", "=backHeight - crestH - lowRail", "=postT * 0.35"], radius: 0.003, region: "frame",
            rotate: [0, "=-deg((-bendW / 2 + (index + 0.5) * bendW / nSlats) / rb)", 0],
            at: ["=rb * sin((-bendW / 2 + (index + 0.5) * bendW / nSlats) / rb)", "=(backHeight - crestH + lowRail) / 2", "=rb * (1 - cos((-bendW / 2 + (index + 0.5) * bendW / nSlats) / rb)) - zEnd"],
        },
        {
            id: "spindles", type: "mesh.cylinder", output: false, when: "=backStyle == 'spindles'", repeat: "=nSpindles", radius: "=clamp(lt * 0.22, 0.006, 0.012)", height: "=backHeight - crestH / 2", segments: 10, region: "frame",
            at: ["=rb * sin((-bendW / 2 + (index + 1) * bendW / (nSpindles + 1)) / rb)", 0, "=rb * (1 - cos((-bendW / 2 + (index + 1) * bendW / (nSpindles + 1)) / rb)) - zEnd"],
        },
        { id: "panelBox", type: "mesh.box", output: false, size: ["=bendW", "=backHeight * 0.55", "=postT * 0.5"], radius: 0.012, divisions: [24, 2, 1] },
        { id: "panel", type: "deform.bend", output: false, when: "=backStyle == 'panel'", mesh: "@panelBox", angle: "=max(backCurve, 0.5)", width: "=bendW", at: [0, "=backHeight * 0.68", "=-zEnd"], region: "frame" },
        { id: "padBox", type: "mesh.box", output: false, size: ["=bendW + postT", "=backHeight - 0.02", 0.06], radius: 0.026, segments: 4, divisions: [24, 2, 1] },
        { id: "pad", type: "deform.bend", output: false, when: "=backStyle == 'upholstered'", mesh: "@padBox", angle: "=max(backCurve, 0.5)", width: "=bendW", at: [0, "=backHeight / 2 + 0.01", "=-zEnd + 0.012"], region: "cushion" },
        { id: "backUnit", type: "geo.join", output: false, meshes: ["@posts", "@ladderRails", "@crestRail", "@lowerRail", "@slats", "@spindles", "@panel", "@pad"] },
        { id: "back", type: "geo.transform", when: "=hasBack", mesh: "@backUnit", rotate: ["=-recline", 0, 0], at: [0, "=hardTop", "=-lz"] },
        // --- Arms: from the back posts forward onto turned supports over the front legs ----------
        { id: "armRests", type: "mesh.box", when: "=arms && hasBack", repeat: 2, size: ["=armT", "=armT * 0.55", "=lz + 0.03 - armBack + postT / 2"], radius: "=armT * 0.25", at: ["=(index * 2 - 1) * bx", "=hardTop + armHeight", "=(lz + 0.03 + armBack - postT / 2) / 2"], region: "frame" },
        { id: "armSupports", type: "mesh.cylinder", when: "=arms && hasBack", repeat: 2, radius: "=lt * 0.35", height: "=armHeight + 0.004", segments: 14, at: ["=(index * 2 - 1) * bx", "=hardTop - 0.004", "=lz - 0.005"], region: "frame" },
    ],
    limits: { maxSize: 3.4, minSize: 0.3, maxTriangles: 90000 },
};

export default chair;
