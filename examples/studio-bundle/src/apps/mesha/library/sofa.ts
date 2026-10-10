import type { ObjectDef } from "../mesha_object";

/**
 * Upholstered seating from a club chair to a four-seat couch: a sprung base on legs or a plinth,
 * seat cushions divided per place (or one bench cushion) sized to the seat, a loose-cushion or tight
 * (optionally button-tufted) back that reclines, track, rolled or padded arms, and throw pillows.
 * A rigid upholstered model: the forms are rounded, not draped. Faces +Z.
 */
const sofa: ObjectDef = {
    id: "furniture.sofa",
    name: "Sofa & Armchair",
    category: "Furniture",
    tags: ["sofa", "couch", "settee", "loveseat", "armchair", "club chair", "chesterfield", "lounge", "living room", "upholstered"],
    description: "Armchairs, loveseats and sofas: cushions, arms, back and legs.",
    featured: ["seats", "seatWidth", "depth", "armStyle", "backStyle", "seatCushions", "legStyle", "upholstery"],
    groups: [
        { id: "size", label: "Size" },
        { id: "cushions", label: "Cushions" },
        { id: "arms", label: "Arms and back" },
        { id: "legs", label: "Legs" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "seats", label: "Seats", type: "int", default: 3, min: 1, max: 4, group: "size", description: "One is an armchair." },
        { id: "seatWidth", label: "Seat width", type: "number", default: 0.6, min: 0.45, max: 0.85, unit: "m", group: "size", description: "Per place." },
        { id: "depth", label: "Depth", type: "number", default: 0.9, min: 0.7, max: 1.15, unit: "m", group: "size" },
        { id: "seatHeight", label: "Seat height", type: "number", default: 0.44, min: 0.36, max: 0.52, unit: "m", group: "size" },
        { id: "backHeight", label: "Back height", type: "number", default: 0.42, min: 0.2, max: 0.7, unit: "m", group: "size", description: "Above the seat." },
        { id: "seatCushions", label: "Seat cushions", type: "enum", default: "perSeat", options: ["perSeat", "bench"], optionLabels: ["One per seat", "One bench cushion"], group: "cushions" },
        { id: "cushionThickness", label: "Cushion thickness", type: "number", default: 0.14, min: 0.07, max: 0.2, unit: "m", decimals: 3, group: "cushions" },
        { id: "softness", label: "Softness", type: "number", default: 0.6, min: 0, max: 1, group: "cushions", description: "How rounded the cushions and edges are." },
        { id: "pillows", label: "Throw pillows", type: "int", default: 2, min: 0, max: "=min(4, seats * 2)", group: "cushions" },
        { id: "armStyle", label: "Arms", type: "enum", default: "track", options: ["none", "track", "rolled", "padded"], optionLabels: ["None", "Track", "Rolled", "Padded"], group: "arms" },
        { id: "armWidth", label: "Arm width", type: "number", default: 0.16, min: 0.06, max: 0.32, unit: "m", group: "arms", visibleIf: "=armStyle != 'none'" },
        { id: "armHeight", label: "Arm height", type: "number", default: 0.2, min: 0.08, max: 0.35, unit: "m", group: "arms", visibleIf: "=armStyle != 'none'", description: "Above the seat." },
        { id: "backStyle", label: "Back", type: "enum", default: "cushions", options: ["cushions", "tight", "tufted"], optionLabels: ["Loose cushions", "Tight back", "Button tufted"], group: "arms" },
        { id: "recline", label: "Recline", type: "number", default: 12, min: 0, max: 25, unit: "°", group: "arms", visibleIf: "=backStyle == 'cushions'" },
        { id: "legStyle", label: "Legs", type: "enum", default: "tapered", options: ["tapered", "round", "square", "turned", "bun", "plinth"], optionLabels: ["Tapered", "Round", "Square", "Turned", "Bun feet", "Plinth"], group: "legs" },
        { id: "legHeight", label: "Leg height", type: "number", default: 0.12, min: 0.02, max: 0.24, unit: "m", group: "legs" },
        { id: "upholstery", label: "Upholstery", type: "material", default: "fabric.oatmeal", materials: ["fabric", "leather"], group: "materials" },
        { id: "pillowFinish", label: "Pillows", type: "material", default: "fabric.rust", materials: ["fabric", "leather"], group: "materials", visibleIf: "=pillows > 0" },
        { id: "legFinish", label: "Legs", type: "material", default: "wood.walnut", materials: ["wood", "metal", "plastic.black"], group: "materials", visibleIf: "=legStyle != 'plinth'" },
        { id: "seed", label: "Seed", type: "seed", default: 6, group: "materials" },
    ],
    derived: {
        hasArms: "=armStyle != 'none'",
        aw: "=hasArms ? armWidth : 0",
        Wi: "=seatWidth * seats",
        W: "=Wi + 2 * aw",
        D: "=depth",
        ch: "=cushionThickness",
        // The sprung base under the cushions.
        baseTop: "=seatHeight - ch",
        baseH: "=baseTop - legHeight",
        bf: "=backStyle == 'cushions' ? 0.16 : 0.22",
        backTop: "=seatHeight + backHeight",
        armTop: "=seatHeight + armHeight",
        nSeat: "=seatCushions == 'bench' ? 1 : seats",
        cgap: 0.006,
        // Seat cushions run from the back (or the back cushions) to just proud of the base.
        bcT: "=clamp(backHeight * 0.38, 0.1, 0.2)",
        seatD: "=D - bf - (backStyle == 'cushions' ? bcT * 0.75 : 0) + 0.02",
        seatZ: "=D / 2 + 0.02 - seatD / 2",
        rnd: "=softness",
        rr: "=aw * 0.55",
        lt: "=clamp(legHeight * 0.4, 0.035, 0.06)",
        nLegs: "=W > 2.0 ? 6 : 4",
        pScale: "=clamp(min(backHeight, Wi / max(pillows, 1)) / 0.5, 0.6, 1.05)",
        tuftRows: "=clamp(round(backHeight / 0.13), 2, 5)",
        tuftCols: "=clamp(round(Wi / 0.15), 3, 30)",
    },
    rules: [
        { check: "=baseH >= 0.06", message: "Legs and cushion leave no room for the base: shorter legs or a thinner cushion." },
        { check: "=seatD >= 0.42", message: "Too shallow to sit in: more depth or a thinner back." },
        { check: "=!hasArms || armTop <= backTop + 0.001", message: "The arms stand above the back." },
        { check: "=W < 3.4", message: "Longer than a sofa frame can be: fewer or narrower seats." },
    ],
    regions: {
        upholstery: { label: "Upholstery", material: "=upholstery" },
        pillows: { label: "Pillows", material: "=pillowFinish" },
        legs: { label: "Legs", material: "=legFinish" },
        buttons: { label: "Buttons", material: "=upholstery" },
    },
    presets: [
        { name: "Modern three-seater", values: { seats: 3, seatWidth: 0.62, depth: 0.95, seatHeight: 0.43, backHeight: 0.4, seatCushions: "perSeat", cushionThickness: 0.15, softness: 0.65, pillows: 2, armStyle: "track", armWidth: 0.15, armHeight: 0.2, backStyle: "cushions", recline: 12, legStyle: "square", legHeight: 0.08, upholstery: "fabric.charcoal", pillowFinish: "fabric.mustard", legFinish: "metal.black" } },
        { name: "Rolled-arm loveseat", values: { seats: 2, seatWidth: 0.62, depth: 0.88, seatHeight: 0.45, backHeight: 0.42, seatCushions: "perSeat", cushionThickness: 0.14, softness: 0.8, pillows: 2, armStyle: "rolled", armWidth: 0.2, armHeight: 0.2, backStyle: "cushions", recline: 10, legStyle: "turned", legHeight: 0.1, upholstery: "fabric.olive", pillowFinish: "fabric.oatmeal", legFinish: "wood.walnut" } },
        { name: "Chesterfield", values: { seats: 3, seatWidth: 0.6, depth: 0.9, seatHeight: 0.44, backHeight: 0.3, seatCushions: "perSeat", cushionThickness: 0.12, softness: 0.45, pillows: 0, armStyle: "rolled", armWidth: 0.22, armHeight: 0.29, backStyle: "tufted", legStyle: "bun", legHeight: 0.06, upholstery: "leather.brown", legFinish: "wood.walnut" } },
        { name: "Club armchair", values: { seats: 1, seatWidth: 0.6, depth: 0.85, seatHeight: 0.44, backHeight: 0.36, cushionThickness: 0.14, softness: 0.7, pillows: 1, armStyle: "padded", armWidth: 0.22, armHeight: 0.22, backStyle: "tight", legStyle: "round", legHeight: 0.07, upholstery: "leather.tan", pillowFinish: "fabric.navy", legFinish: "wood.walnut" } },
        { name: "Mid-century sofa", values: { seats: 3, seatWidth: 0.58, depth: 0.8, seatHeight: 0.44, backHeight: 0.36, seatCushions: "bench", cushionThickness: 0.12, softness: 0.3, pillows: 0, armStyle: "track", armWidth: 0.08, armHeight: 0.16, backStyle: "cushions", recline: 14, legStyle: "tapered", legHeight: 0.2, upholstery: "fabric.mustard", legFinish: "wood.walnut" } },
        { name: "Modular low couch", values: { seats: 4, seatWidth: 0.7, depth: 1.1, seatHeight: 0.38, backHeight: 0.3, seatCushions: "perSeat", cushionThickness: 0.17, softness: 0.95, pillows: 3, armStyle: "padded", armWidth: 0.25, armHeight: 0.14, backStyle: "cushions", recline: 18, legStyle: "plinth", legHeight: 0.04, upholstery: "fabric.oatmeal", pillowFinish: "fabric.forest" } },
    ],
    nodes: [
        // --- Base and frame ---------------------------------------------------------------------
        { id: "base", type: "mesh.box", size: ["=W", "=baseH", "=D"], radius: "=min(baseH * 0.45, 0.012 + rnd * 0.04)", segments: 4, at: [0, "=legHeight + baseH / 2", 0], region: "upholstery" },
        { id: "backFrame", type: "mesh.box", size: ["=W", "=backTop - baseTop + (backStyle == 'cushions' ? 0 : 0.02)", "=bf"], radius: "=min(bf * 0.45, 0.015 + rnd * 0.05)", segments: 4, at: [0, "=(backTop + baseTop) / 2", "=-D / 2 + bf / 2"], region: "upholstery" },
        // --- Arms ---------------------------------------------------------------------------------
        { id: "arms", type: "mesh.box", when: "=armStyle == 'track' || armStyle == 'padded'", repeat: 2, size: ["=aw", "=armTop - legHeight", "=D"], radius: "=armStyle == 'padded' ? min(aw * 0.48, 0.03 + rnd * 0.08) : min(aw * 0.3, 0.01 + rnd * 0.02)", segments: 4, at: ["=(index * 2 - 1) * (W / 2 - aw / 2)", "=legHeight + (armTop - legHeight) / 2", 0], region: "upholstery" },
        // Rolled: a lower arm panel and a scroll curling outward along its top.
        { id: "rolledPanel", type: "mesh.box", when: "=armStyle == 'rolled'", repeat: 2, size: ["=aw * 0.8", "=armTop - legHeight - rr", "=D"], radius: "=min(aw * 0.2, 0.02)", segments: 3, at: ["=(index * 2 - 1) * (W / 2 - aw * 0.6)", "=legHeight + (armTop - legHeight - rr) / 2", 0], region: "upholstery" },
        { id: "rolls", type: "mesh.cylinder", when: "=armStyle == 'rolled'", repeat: 2, radius: "=rr", height: "=D", segments: 28, bevel: "=rr * 0.35", bevelSegments: 4, rotate: [90, 0, 0], at: ["=(index * 2 - 1) * (W / 2 - rr)", "=armTop - rr", "=-D / 2"], region: "upholstery" },
        // --- Seat cushions, per place or one bench ----------------------------------------------
        { id: "seatPads", type: "mesh.box", repeat: "=nSeat", size: ["=Wi / nSeat - cgap", "=ch", "=seatD"], radius: "=min(ch * 0.48, 0.015 + rnd * 0.05)", segments: 4, at: ["=-Wi / 2 + (index + 0.5) * Wi / nSeat", "=baseTop + ch / 2", "=seatZ"], region: "upholstery" },
        // --- Back: loose cushions leaning on the frame, or a tight back with optional tufting ------
        { id: "backPad", type: "mesh.box", output: false, size: ["=Wi / seats - cgap", "=backHeight * 0.92", "=bcT"], radius: "=min(bcT * 0.48, 0.02 + rnd * 0.06)", segments: 4, at: [0, "=backHeight * 0.46", "=bcT / 2"] },
        { id: "backPads", type: "geo.transform", when: "=backStyle == 'cushions'", repeat: "=seats", mesh: "@backPad", rotate: ["=-recline", 0, 0], at: ["=-Wi / 2 + (index + 0.5) * Wi / seats", "=seatHeight - 0.01", "=-D / 2 + bf"], region: "upholstery" },
        { id: "tightBack", type: "mesh.box", when: "=backStyle != 'cushions'", size: ["=Wi", "=backHeight - 0.02", 0.07], radius: "=0.015 + rnd * 0.02", segments: 3, at: [0, "=seatHeight + (backHeight - 0.02) / 2", "=-D / 2 + bf + 0.02"], region: "upholstery" },
        {
            id: "tufts", type: "mesh.sphere", when: "=backStyle == 'tufted'", repeat: "=tuftRows * tuftCols", radius: 0.009, segments: 8, rings: 4, scale: [1, 1, 0.5], region: "buttons",
            at: ["=-Wi / 2 + ((index % tuftCols) + 0.5 + (floor(index / tuftCols) % 2) * 0.5 - 0.25) * Wi / tuftCols", "=seatHeight + 0.06 + (floor(index / tuftCols) + 0.5) * (backHeight - 0.1) / tuftRows", "=-D / 2 + bf + 0.055"],
        },
        // --- Throw pillows leaning into the corners ---------------------------------------------
        { id: "pillow", type: "mesh.box", output: false, size: [0.42, 0.42, 0.13], radius: 0.06, segments: 4, at: [0, 0.21, 0.065] },
        {
            id: "throwPillows", type: "geo.transform", when: "=pillows > 0", repeat: "=pillows", mesh: "@pillow", region: "pillows",
            scale: "=pScale",
            rotate: ["=backStyle == 'cushions' ? -recline - 5 : -12", "=index % 2 == 0 ? 16 : -16", "=index % 2 == 0 ? -5 : 5"],
            at: ["=(index % 2 == 0 ? -1 : 1) * (Wi / 2 - pScale * 0.21 - 0.05 - floor(index / 2) * (pScale * 0.42 + 0.04))", "=seatHeight - 0.01", "=-D / 2 + bf + (backStyle == 'cushions' ? bcT + 0.02 : 0.07)"],
        },
        // --- Legs or a plinth ---------------------------------------------------------------------
        {
            id: "legs", type: "object", object: "component.leg", when: "=legStyle != 'plinth' && legStyle != 'bun'", repeat: "=nLegs", region: "legs",
            params: { height: "=legHeight + 0.004", thickness: "=lt", style: "=legStyle", taper: 0.6 },
            at: ["=index < 4 ? (index % 2 * 2 - 1) * (W / 2 - lt / 2 - 0.03) : 0", 0, "=((index < 4 ? floor(index / 2) : index - 4) * 2 - 1) * (D / 2 - lt / 2 - 0.03)"],
        },
        { id: "bunFeet", type: "mesh.cylinder", when: "=legStyle == 'bun'", repeat: "=nLegs", radius: "=clamp(legHeight * 0.75, 0.025, 0.05)", height: "=legHeight + 0.004", segments: 24, bevel: "=legHeight * 0.45", bevelSegments: 4, region: "legs", at: ["=index < 4 ? (index % 2 * 2 - 1) * (W / 2 - 0.07) : 0", 0, "=((index < 4 ? floor(index / 2) : index - 4) * 2 - 1) * (D / 2 - 0.07)"] },
        { id: "plinth", type: "mesh.box", when: "=legStyle == 'plinth'", size: ["=W - 0.06", "=legHeight + 0.004", "=D - 0.06"], at: [0, "=(legHeight + 0.004) / 2", 0], region: "upholstery" },
    ],
    limits: { maxSize: 3.6, minSize: 0.6, maxTriangles: 60000 },
};

export default sofa;
