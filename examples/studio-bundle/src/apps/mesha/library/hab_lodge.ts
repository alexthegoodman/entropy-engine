import type { ObjectDef } from "../mesha_object";

// An interplanetary lodge: a pill-sectioned habitat hull on landing legs, one or two decks of guest
// cabins off a central corridor. Plan of a deck (front at +Z, the hull's long axis along X):
//
//   +---------+-----+-----+------+-----+-----+---------+   The cabin zone is 2k + 1 cells of
//   |         | cab | cab | core | cab | cab |         |   `cabinWidth`: k cabins each side of
//   | lounge  |------------ corridor ----------|  lounge |   the centre cell. At the back the
//   |  (dome) | cab | cab | lock | cab | cab |         |   centre cell is the stair core; at the
//   +---------+-----+-----+-hatch+-----+-----+---------+   front on the lower deck, the airlock.
//
// Section: flat side walls between rounded shoulders (radius R). The decks live between the
// shoulders: floor 0 at H0 = belly + R, the top ceiling at yC; the keel and crown are service voids.
// Walls and outlines use the house's conventions: rotate [-90, 0, 0] runs an outline's (u, v) along
// (+X, up) with its thickness toward -Z; rotate [-90, -90, 0] runs (u, v) along (+Z, up) with the
// thickness toward +X. Every window, door frame and cabin wall is built once and placed.

const N_ARC = 8;
/** "=expr" points of a quarter arc about (cu, cv) from a0 to a1 degrees (inclusive). */
const arc = (cu: string, cv: string, r: string, a0: number, a1: number, n = N_ARC): [string, string][] =>
    Array.from({ length: n + 1 }, (_, k) => {
        const a = a0 + ((a1 - a0) * k) / n;
        return [`=${cu} + (${r}) * cos(rad(${a}))`, `=${cv} + (${r}) * sin(rad(${a}))`];
    });
/** The hull's cross-section (u = z, v = y), optionally cut flat at `top`. */
const section = (inset: string, cut: boolean): [string, string][] => [
    ...arc(`D2 - R`, `H0`, `R - (${inset})`, 270, 360),
    ...(cut ? [[`=D2 - (${inset})`, `=yTopShown`], [`=-D2 + (${inset})`, `=yTopShown`]] as [string, string][]
        : [...arc(`D2 - R`, `yC`, `R - (${inset})`, 0, 90), ...arc(`-D2 + R`, `yC`, `R - (${inset})`, 90, 180)]),
    ...arc(`-D2 + R`, `H0`, `R - (${inset})`, 180, 270),
];
/** A ring around the section cut flat at the shown top: a U from `outer` to `inner` inset. */
const sectionU = (outer: string, inner: string): [string, string][] => [
    ...arc(`-D2 + R`, `H0`, `R - (${outer})`, 180, 270),
    ...arc(`D2 - R`, `H0`, `R - (${outer})`, 270, 360),
    [`=D2 - (${outer})`, `=yTopShown`], [`=D2 - (${inner})`, `=yTopShown`],
    ...arc(`D2 - R`, `H0`, `R - (${inner})`, 360, 270),
    ...arc(`-D2 + R`, `H0`, `R - (${inner})`, 270, 180),
    [`=-D2 + (${inner})`, `=yTopShown`], [`=-D2 + (${outer})`, `=yTopShown`],
];
/** The spiral stair's handrail: `n` points over its sweep, 0.9 m above the tread nosings. */
const RAIL_N = 24;
const spiralRail = (r: string): [string, string, string][] => Array.from({ length: RAIL_N + 1 }, (_, k) => {
    const f = `(${k} / ${RAIL_N})`;
    return [`=(${r}) * cos(rad(th0 + ${f} * (nT - 1) * da))`, `=rh + ${f} * (nT - 1) * rh + 0.9`, `=(${r}) * sin(rad(th0 + ${f} * (nT - 1) * da))`];
});
/** Dome meridian (radius, height) from the rim to the crown. */
const dome = (r: string, h: string, n = 10): [string, string][] => Array.from({ length: n + 1 }, (_, k) => {
    const a = (90 * k) / n;
    return [`=(${r}) * cos(rad(${a}))`, `=(${h}) * sin(rad(${a}))`];
});

export const habLodgeDef: ObjectDef = {
    id: "architecture.hab_lodge",
    name: "Hab Lodge",
    category: "Architecture",
    tags: ["hab", "habitat", "lodge", "hotel", "inn", "space", "sci-fi", "scifi", "futuristic", "interplanetary", "mars", "moon", "lunar", "colony", "outpost", "module", "cabins", "building", "interior", "high-tech"],
    description: "Interplanetary lodgings: a panelled habitat hull on landing legs with guest cabins off a central corridor, an airlock and boarding stair, a spiral stair between decks and an observation dome.",
    featured: ["cabins", "decks", "cabinWidth", "beam", "lounge", "lift", "cupola", "solar", "hullFinish", "glowFinish"],
    groups: [
        { id: "size", label: "Hull" },
        { id: "plan", label: "Cabins and corridor" },
        { id: "entry", label: "Airlock" },
        { id: "windows", label: "Viewports" },
        { id: "gear", label: "Legs and systems" },
        { id: "view", label: "Inspect" },
        { id: "materials", label: "Exterior materials" },
        { id: "interiorMaterials", label: "Interior materials" },
    ],
    params: [
        // --- Hull ---
        { id: "decks", label: "Decks", type: "int", default: 2, min: 1, max: 2, group: "size" },
        { id: "deckHeight", label: "Deck height", type: "number", default: 2.85, min: 2.6, max: 3.3, unit: "m", group: "size", description: "Floor to floor; the crown and keel voids come on top." },
        { id: "beam", label: "Hull width", type: "number", default: 7.6, min: "=2 * (0.18 + 0.12 + 2.3) + corridor", max: 10, unit: "m", group: "size", description: "Cabins either side of the corridor are at least 2.3 m deep." },
        { id: "shoulder", label: "Shoulder radius", type: "number", default: 1.3, min: 0.55, max: "=min(1.5, beam * 0.2)", unit: "m", group: "size" },
        { id: "lounge", label: "Lounge length", type: "number", default: 3.6, min: 2, max: 6.5, unit: "m", group: "size", description: "The open lounges at both ends; the observation dome stands over one." },
        { id: "lift", label: "Ground clearance", type: "number", default: 1.35, min: 0.6, max: 2.6, unit: "m", group: "size" },
        // --- Cabins ---
        { id: "cabins", label: "Cabins each side", type: "int", default: 2, min: 1, max: 3, group: "plan", description: "Cabins either side of the centre cell, on each side of the corridor and on each deck." },
        { id: "cabinWidth", label: "Cabin width", type: "number", default: 2.7, min: 2.4, max: 3.6, unit: "m", group: "plan" },
        { id: "corridor", label: "Corridor width", type: "number", default: 1.45, min: 1.2, max: 2.1, unit: "m", group: "plan" },
        // --- Airlock ---
        { id: "hatchWidth", label: "Hatch width", type: "number", default: 1.1, min: 0.9, max: "=min(1.5, cabinWidth - 1.1, (cabinWidth - 0.61) / 1.5)", unit: "m", group: "entry" },
        { id: "hatchHeight", label: "Hatch height", type: "number", default: 2.1, min: 1.95, max: "=deckHeight - 0.62", unit: "m", group: "entry" },
        { id: "hatchOpen", label: "Hatch open", type: "number", default: 1, min: 0, max: 1, group: "entry", description: "Slides the outer hatch aside." },
        { id: "awning", label: "Hatch canopy", type: "bool", default: true, group: "entry" },
        // --- Viewports ---
        { id: "windowWidth", label: "Viewport width", type: "number", default: 1.3, min: 0.6, max: "=min(2.2, cabinWidth - 0.8, 2 * (cabinWidth - 1.5 * hatchWidth - 0.31))", unit: "m", group: "windows", description: "Kept clear of the partitions and of the open hatch beside the airlock." },
        { id: "windowHeight", label: "Viewport height", type: "number", default: 0.8, min: 0.45, max: "=deckHeight - 0.56 - sill", unit: "m", group: "windows" },
        { id: "sill", label: "Viewport sill", type: "number", default: 0.95, min: 0.45, max: 1.3, unit: "m", group: "windows" },
        { id: "panorama", label: "Lounge panoramas", type: "bool", default: true, group: "windows", description: "Long viewports along the lounges and across the hull's ends." },
        // --- Legs and systems ---
        { id: "legs", label: "Landing legs", type: "enum", default: "four", options: ["four", "eight"], optionLabels: ["Four", "Eight"], group: "gear" },
        { id: "legSplay", label: "Leg splay", type: "number", default: 0.85, min: 0.3, max: 1.6, unit: "m", group: "gear" },
        { id: "pad", label: "Landing pad", type: "bool", default: true, group: "gear" },
        { id: "cupola", label: "Observation dome", type: "bool", default: true, group: "gear" },
        { id: "cupolaSize", label: "Dome size", type: "number", default: 0.9, min: 0.45, max: 1, group: "gear", visibleIf: "=cupola", description: "As a share of the largest dome the lounge takes." },
        { id: "solar", label: "Solar arrays", type: "int", default: 2, min: 0, max: 4, group: "gear" },
        { id: "radiators", label: "Radiator fins", type: "bool", default: true, group: "gear" },
        { id: "antenna", label: "Antenna dish", type: "bool", default: true, group: "gear" },
        { id: "bands", label: "Hull rings", type: "bool", default: true, group: "gear", description: "Structural rings at every cabin wall." },
        { id: "lightStrips", label: "Light strips", type: "bool", default: true, group: "gear" },
        // --- Inspect ---
        { id: "roofVisible", label: "Show roof", type: "bool", default: true, group: "view", variation: 0, description: "Lift the crown, top ceiling and roof gear off to look into the top deck." },
        { id: "cutaway", label: "Hide top deck", type: "int", default: 0, min: 0, max: "=decks - 1", group: "view", variation: 0 },
        // --- Materials ---
        { id: "hullFinish", label: "Hull", type: "material", default: "composite.white", materials: ["composite", "paint", "metal.titanium", "metal.aluminum", "metal.gold"], group: "materials" },
        { id: "accentFinish", label: "Rings, hatch and canopy", type: "material", default: "composite.grey", materials: ["composite", "paint", "metal"], group: "materials" },
        { id: "frameFinish", label: "Viewport frames", type: "material", default: "metal.black", materials: ["metal", "composite", "paint"], group: "materials" },
        { id: "strutFinish", label: "Legs and masts", type: "material", default: "metal.titanium", materials: ["metal", "composite", "paint"], group: "materials" },
        { id: "glowFinish", label: "Lights", type: "material", default: "glow.cyan", materials: ["glow"], group: "materials" },
        { id: "glassFinish", label: "Glazing", type: "material", default: "glass.tinted", materials: ["glass"], group: "materials" },
        { id: "radiatorFinish", label: "Radiators", type: "material", default: "metal.aluminum", materials: ["metal", "composite", "paint"], group: "materials", visibleIf: "=radiators" },
        { id: "padFinish", label: "Landing pad", type: "material", default: "masonry.concrete", materials: ["masonry", "stone", "metal.black"], group: "materials", visibleIf: "=pad" },
        { id: "interiorFinish", label: "Interior walls", type: "material", default: "composite.white", materials: ["composite", "paint", "metal.aluminum", "wood"], group: "interiorMaterials" },
        { id: "floorFinish", label: "Decks", type: "material", default: "composite.grey", materials: ["composite", "metal", "wood", "stone"], group: "interiorMaterials" },
        { id: "stairFinish", label: "Stair", type: "material", default: "metal.steel", materials: ["metal", "composite", "wood"], group: "interiorMaterials", visibleIf: "=decks > 1" },
        { id: "seed", label: "Seed", type: "seed", default: 41, group: "materials", variation: 0 },
    ],
    derived: {
        // Section.
        th: 0.18, pt: 0.12, s: 0.26,
        ph: "=pad ? 0.16 : 0",
        yb: "=ph + lift", R: "=shoulder",
        H0: "=yb + R", dH: "=deckHeight",
        yC: "=H0 + decks * dH", yt: "=yC + R",
        D2: "=beam / 2", zi: "=D2 - th",
        shownD: "=max(1, decks - cutaway)",
        cut: "=shownD < decks",
        yTopShown: "=H0 + shownD * dH",
        roofShown: "=roofVisible && !cut",
        // Plan.
        cw: "=cabinWidth", nC: "=2 * cabins + 1", kC: "=cabins",
        Zc2: "=nC * cw / 2", L2: "=Zc2 + lounge + th", innerL: "=2 * (Zc2 + lounge)",
        cz: "=corridor / 2", cd: "=zi - cz - pt", zCab: "=cz + pt + cd / 2",
        // Doorways: dw x dh with 45-degree chamfered heads.
        dw: 0.9, dh: 2.1, dc: 0.2, df: 0.07,
        // Viewports.
        ww: "=windowWidth", wh: "=windowHeight", wr: "=min(windowWidth, windowHeight) * 0.3",
        lw: "=lounge - 0.9",
        capW: "=min(beam - 2 * R - 0.3, 5.2)", capH: "=wh + 0.2", capSill: "=sill - 0.2",
        // Airlock.
        hw: "=hatchWidth", hh: "=hatchHeight", hr: "=min(hatchWidth, hatchHeight) * 0.28", hs: 0.1,
        ySill: "=H0 + hs",
        pD: 1.3, pW: "=hatchWidth + 1.3",
        nB: "=ceil((ySill - ph) / 0.19)", rB: "=(ySill - ph) / nB", goB: 0.28,
        zP: "=D2 + pD",
        runB: "=(nB - 1) * goB",
        slopeB: "=atan2(rB, goB)",
        // Spiral stair in the core: nT treads over 300 degrees, rising toward +theta from the corridor side.
        nR: "=ceil(dH / 0.19)", rh: "=dH / nR", nT: "=nR - 1", da: "=300 / nT",
        rs: "=min(cw, cd) / 2 - 0.12", zS: "=-zCab",
        th0: "=90 - da / 2", thEnd: "=th0 + 300",
        holeR: "=rs + 0.1",
        stairShown: "=decks > 1 && shownD > 1",
        // Dome over the -X lounge.
        rcMax: "=min(lounge / 2 - 0.2, D2 - R - 0.25, 2.3)",
        rc: "=rcMax * cupolaSize", domeH: "=rc * 0.85",
        xDome: "=-(Zc2 + lounge / 2)",
        hasDome: "=cupola && roofShown",
        // Legs: pairs at xLeg (and xIn for eight), front and back.
        xLeg: "=L2 - 1.4", xIn: "=max(1.7, (L2 - 1.4) * 0.42)",
        nLeg: "=legs == 'eight' ? 8 : 4",
        legAZ: "=D2 - R + R * 0.707", legAY: "=H0 - R * 0.707",
        footZ: "=D2 + legSplay",
        kneeZ: "=D2 + legSplay * 0.72 + 0.12", kneeY: "=ph + (H0 - R * 0.707 - ph) * 0.45",
        // Roof gear.
        nSol: "=roofShown ? solar : 0",
        solPitch: "=2 * Zc2 / max(1, solar)",
        solW: "=min(solPitch - 0.5, 3.2)", solD: "=min(beam - 2 * R + 0.6, 2.6)",
        nFins: "=radiators && roofShown ? nC : 0",
        xAnt: "=Zc2 + lounge / 2",
        padX: "=L2 + 0.9", padZ0: "=footZ + 1.0", padZ1: "=max(footZ + 1.0, zP + runB + 0.8)",
    },
    rules: [
        { check: "=rs >= 0.8 || decks < 2", message: "The stair core is too small for a spiral stair: widen the cabins or the hull." },
        { check: "=!cupola || rc >= 0.7", message: "The lounge is too short for an observation dome." },
        { check: "=cd >= 2.3 - 1e-6", message: "The cabins are shallower than 2.3 m." },
    ],
    regions: {
        hull: { label: "Hull", material: "=hullFinish" },
        accent: { label: "Rings, hatch and canopy", material: "=accentFinish" },
        frame: { label: "Viewport frames", material: "=frameFinish" },
        glass: { label: "Glazing", material: "=glassFinish" },
        struts: { label: "Legs and masts", material: "=strutFinish" },
        piston: { label: "Pistons", material: "metal.chrome" },
        lights: { label: "Lights", material: "=glowFinish" },
        navRed: { label: "Port light", material: "glow.red" },
        navGreen: { label: "Starboard light", material: "glow.green" },
        radiator: { label: "Radiators", material: "=radiatorFinish" },
        solar: { label: "Solar cells", material: "solar.cell" },
        pad: { label: "Landing pad", material: "=padFinish" },
        padMarks: { label: "Pad markings", material: "paint.ochre" },
        interior: { label: "Interior walls", material: "=interiorFinish" },
        ceiling: { label: "Ceilings", material: "=interiorFinish" },
        floors: { label: "Decks", material: "=floorFinish" },
        stair: { label: "Stair", material: "=stairFinish" },
        grating: { label: "Boarding stair", material: "metal.black" },
    },
    presets: [
        { name: "Orbital lodge", values: {} },
        { name: "Mars outpost inn", values: { decks: 1, cabins: 2, cabinWidth: 2.8, beam: 7.2, lounge: 4, lift: 1.1, shoulder: 1.2, legSplay: 1.1, solar: 3, hullFinish: "composite.orange", accentFinish: "composite.white", frameFinish: "metal.black", glowFinish: "glow.amber", padFinish: "stone.regolith", floorFinish: "metal.black", interiorFinish: "composite.white", windowWidth: 1.0, windowHeight: 0.7 } },
        { name: "Luxury star hotel", values: { decks: 2, cabins: 3, cabinWidth: 3.2, beam: 8.8, deckHeight: 3.1, lounge: 5.5, lift: 1.8, shoulder: 1.4, legs: "eight", windowWidth: 2, windowHeight: 1.15, sill: 0.7, solar: 4, hullFinish: "composite.white", accentFinish: "metal.gold", frameFinish: "metal.gold", glowFinish: "glow.magenta", glassFinish: "glass.violet", floorFinish: "wood.walnut", interiorFinish: "composite.white", stairFinish: "metal.brass", padFinish: "stone.marble" } },
        { name: "Lunar bunkhouse", values: { decks: 1, cabins: 1, cabinWidth: 2.4, beam: 6.4, corridor: 1.2, lounge: 2.6, lift: 0.8, shoulder: 0.8, legSplay: 0.6, hatchWidth: 0.95, windowWidth: 0.7, windowHeight: 0.55, panorama: false, solar: 1, radiators: false, cupolaSize: 1, hullFinish: "composite.grey", accentFinish: "metal.gold", frameFinish: "metal.black", glowFinish: "glow.white", padFinish: "stone.regolith", interiorFinish: "metal.aluminum", floorFinish: "metal.black" } },
        { name: "Deep-space research lodge", values: { decks: 2, cabins: 2, cabinWidth: 2.6, beam: 7, lounge: 3, lift: 2.2, legs: "eight", legSplay: 1.4, shoulder: 0.9, windowWidth: 1.1, pad: false, solar: 4, hullFinish: "metal.titanium", accentFinish: "composite.orange", frameFinish: "composite.grey", strutFinish: "metal.black", glowFinish: "glow.green", glassFinish: "glass.clear", interiorFinish: "composite.grey", floorFinish: "metal.steel" } },
    ],
    nodes: [
        // ================= Landing pad =================
        // A chamfered slab under the legs and the boarding stair, with a painted border and edge lights.
        { id: "padOutline", type: "curve.points", output: false, closed: true, points: [["=-padX + 1.2", "=-padZ0"], ["=padX - 1.2", "=-padZ0"], ["=padX", "=-padZ0 + 1.2"], ["=padX", "=padZ1 - 1.2"], ["=padX - 1.2", "=padZ1"], ["=-padX + 1.2", "=padZ1"], ["=-padX", "=padZ1 - 1.2"], ["=-padX", "=-padZ0 + 1.2"]] },
        { id: "padSlab", type: "mesh.extrude", when: "=pad", outline: "@padOutline", height: "=ph", bevel: 0.03, region: "pad" },
        { id: "padMarkOuter", type: "curve.rect", output: false, width: "=2 * padX - 1.0", height: "=padZ0 + padZ1 - 1.0", radius: 0.9, cornerSegments: 8 },
        { id: "padMarkInner", type: "curve.rect", output: false, width: "=2 * padX - 1.3", height: "=padZ0 + padZ1 - 1.3", radius: 0.75, cornerSegments: 8 },
        { id: "padMark", type: "mesh.extrude", when: "=pad", outline: "@padMarkOuter", holes: ["@padMarkInner"], height: 0.012, at: [0, "=ph", "=(padZ1 - padZ0) / 2"], region: "padMarks" },
        { id: "padLights", type: "mesh.sphere", when: "=pad && lightStrips", repeat: 8, radius: 0.1, segments: 10, rings: 5, at: ["=[-padX + 1.35, padX - 1.35, padX - 0.15, padX - 0.15, padX - 1.35, -padX + 1.35, -padX + 0.15, -padX + 0.15][index]", "=ph", "=[-padZ0 + 0.15, -padZ0 + 0.15, -padZ0 + 1.35, padZ1 - 1.35, padZ1 - 0.15, padZ1 - 0.15, padZ1 - 1.35, -padZ0 + 1.35][index]"], region: "lights" },

        // ================= Hull shell =================
        // Flat side walls, one segment per cell and deck, each with its viewport (or the hatch).
        { id: "cellOutline", type: "curve.rect", output: false, width: "=cw", height: "=dH" },
        { id: "cellOutlineAt", type: "curve.transform", output: false, curve: "@cellOutline", offset: [0, "=dH / 2"] },
        { id: "viewportHole", type: "curve.rect", output: false, width: "=ww", height: "=wh", radius: "=wr", cornerSegments: 6 },
        { id: "viewportHoleAt", type: "curve.transform", output: false, curve: "@viewportHole", offset: [0, "=sill + wh / 2"] },
        { id: "hatchHole", type: "curve.rect", output: false, width: "=hw", height: "=hh", radius: "=hr", cornerSegments: 6 },
        { id: "hatchHoleAt", type: "curve.transform", output: false, curve: "@hatchHole", offset: [0, "=hs + hh / 2"] },
        {
            // index % nC: cell; floor(index / nC) % 2: front or back; floor(index / (2 nC)): deck.
            id: "sideWalls", type: "mesh.extrude", repeat: "=2 * nC * shownD", outline: "@cellOutlineAt",
            holes: [{ if: "=index % nC == kC && floor(index / nC) % 2 == 0 && floor(index / (2 * nC)) == 0", then: "@hatchHoleAt", else: "@viewportHoleAt" }],
            height: "=th", rotate: [-90, "=floor(index / nC) % 2 == 0 ? 0 : 180", 0],
            at: ["=-Zc2 + (index % nC + 0.5) * cw", "=H0 + floor(index / (2 * nC)) * dH", "=floor(index / nC) % 2 == 0 ? D2 : -D2"], region: "hull",
        },
        // Lounge walls at both ends, front and back, with a long panorama.
        { id: "loungeOutline", type: "curve.rect", output: false, width: "=lounge", height: "=dH" },
        { id: "loungeOutlineAt", type: "curve.transform", output: false, curve: "@loungeOutline", offset: [0, "=dH / 2"] },
        { id: "panoHole", type: "curve.rect", output: false, width: "=lw", height: "=wh", radius: "=wr", cornerSegments: 6 },
        { id: "panoHoleAt", type: "curve.transform", output: false, curve: "@panoHole", offset: [0, "=sill + wh / 2"] },
        {
            // index % 2: -X or +X end; floor(index / 2) % 2: front or back; floor(index / 4): deck.
            id: "loungeWalls", type: "mesh.extrude", repeat: "=4 * shownD", outline: "@loungeOutlineAt", holes: { if: "=panorama", then: ["@panoHoleAt"], else: [] },
            height: "=th", rotate: [-90, "=floor(index / 2) % 2 == 0 ? 0 : 180", 0],
            at: ["=(index % 2 == 0 ? -1 : 1) * (Zc2 + lounge / 2)", "=H0 + floor(index / 4) * dH", "=floor(index / 2) % 2 == 0 ? D2 : -D2"], region: "hull",
        },
        // Shoulders: quarter tubes along the hull (the crown pair only with the roof on).
        { id: "shoulderArc0", type: "curve.sector", output: false, inner: "=R - th", outer: "=R", start: 0, end: 90, radius: 0, segments: 16 },
        { id: "shoulderArc1", type: "curve.sector", output: false, inner: "=R - th", outer: "=R", start: 90, end: 180, radius: 0, segments: 16 },
        { id: "shoulderArc2", type: "curve.sector", output: false, inner: "=R - th", outer: "=R", start: 180, end: 270, radius: 0, segments: 16 },
        { id: "shoulderArc3", type: "curve.sector", output: false, inner: "=R - th", outer: "=R", start: 270, end: 360, radius: 0, segments: 16 },
        { id: "crownF", type: "curve.transform", output: false, curve: "@shoulderArc0", offset: ["=D2 - R", "=yC"] },
        { id: "crownB", type: "curve.transform", output: false, curve: "@shoulderArc1", offset: ["=-D2 + R", "=yC"] },
        { id: "keelB", type: "curve.transform", output: false, curve: "@shoulderArc2", offset: ["=-D2 + R", "=H0"] },
        { id: "keelF", type: "curve.transform", output: false, curve: "@shoulderArc3", offset: ["=D2 - R", "=H0"] },
        {
            // index: 0 crown front, 1 crown back, 2 keel back, 3 keel front.
            id: "shoulders", type: "mesh.extrude", repeat: 4, keep: "=index >= 2 || roofShown",
            outline: { switch: "=index", cases: { "0": "@crownF", "1": "@crownB", "2": "@keelB" }, default: "@keelF" }, height: "=innerL",
            rotate: [-90, -90, 0], at: ["=-Zc2 - lounge", 0, 0], region: "hull",
        },
        { id: "keelPlate", type: "mesh.box", size: ["=innerL", "=th", "=beam - 2 * R + 0.002"], at: [0, "=yb + th / 2", 0], region: "hull" },
        { id: "crownPlate", type: "mesh.extrude", when: "=roofShown", outline: "@crownOutline", holes: { if: "=cupola", then: ["@domeHole"], else: [] }, height: "=th", at: [0, "=yt - th", 0], region: "hull" },
        { id: "crownOutline", type: "curve.points", output: false, closed: true, points: [["=-Zc2 - lounge", "=-D2 + R - 0.001"], ["=Zc2 + lounge", "=-D2 + R - 0.001"], ["=Zc2 + lounge", "=D2 - R + 0.001"], ["=-Zc2 - lounge", "=D2 - R + 0.001"]] },
        { id: "domeHole", type: "curve.circle", output: false, radius: "=rc", segments: 48, center: ["=xDome", 0] },
        // End caps: the full section with its panoramas, bevelled rims.
        { id: "capSection", type: "curve.points", output: false, closed: true, points: section("0", false) },
        { id: "capSectionCut", type: "curve.points", output: false, closed: true, points: section("0", true) },
        { id: "capPano", type: "curve.rect", output: false, width: "=capW", height: "=capH", radius: "=wr", cornerSegments: 6 },
        { id: "capPanoAt", type: "curve.transform", output: false, curve: "@capPano", offset: [0, "=H0 + capSill + capH / 2"] },
        { id: "capPanos", type: "curves.linear", output: false, curve: "@capPanoAt", count: "=shownD", offset: [0, "=dH"], centered: false },
        {
            id: "endCaps", type: "mesh.extrude", repeat: 2, outline: { if: "=cut", then: "@capSectionCut", else: "@capSection" }, holes: { if: "=panorama", then: ["@capPanos"], else: [] },
            height: "=th", bevel: 0.05, rotate: [-90, -90, 0], at: ["=index == 0 ? -L2 : L2 - th", 0, 0], region: "hull",
        },

        // ================= Viewports and hatch =================
        // A viewport in wall-local coordinates: wall centre plane at z = 0, outside +Z, bottom of the glass at y = 0.
        { id: "vpFrameOuter", type: "curve.rect", output: false, width: "=ww + 0.16", height: "=wh + 0.16", radius: "=wr + 0.08", cornerSegments: 6 },
        { id: "vpRing", type: "mesh.extrude", output: false, outline: "@vpFrameOuter", holes: ["@viewportHole"], height: "=th + 0.08", bevel: 0.015, rotate: [-90, 0, 0], at: [0, "=wh / 2", "=(th + 0.08) / 2"], region: "frame" },
        { id: "vpGlass", type: "mesh.extrude", output: false, outline: "@viewportHole", height: 0.03, rotate: [-90, 0, 0], at: [0, "=wh / 2", 0.015], region: "glass" },
        { id: "viewport", type: "geo.join", output: false, meshes: ["@vpRing", "@vpGlass"] },
        {
            id: "viewports", type: "geo.transform", repeat: "=2 * nC * shownD", keep: "=!(index % nC == kC && floor(index / nC) % 2 == 0 && floor(index / (2 * nC)) == 0)", mesh: "@viewport",
            rotate: [0, "=floor(index / nC) % 2 == 0 ? 0 : 180", 0],
            at: ["=-Zc2 + (index % nC + 0.5) * cw", "=H0 + floor(index / (2 * nC)) * dH + sill", "=(floor(index / nC) % 2 == 0 ? 1 : -1) * (D2 - th / 2)"],
        },
        { id: "panoFrameOuter", type: "curve.rect", output: false, width: "=lw + 0.16", height: "=wh + 0.16", radius: "=wr + 0.08", cornerSegments: 6 },
        { id: "panoRing", type: "mesh.extrude", output: false, when: "=panorama", outline: "@panoFrameOuter", holes: ["@panoHole"], height: "=th + 0.08", bevel: 0.015, rotate: [-90, 0, 0], at: [0, "=wh / 2", "=(th + 0.08) / 2"], region: "frame" },
        { id: "panoGlass", type: "mesh.extrude", output: false, when: "=panorama", outline: "@panoHole", height: 0.03, rotate: [-90, 0, 0], at: [0, "=wh / 2", 0.015], region: "glass" },
        { id: "panoUnit", type: "geo.join", output: false, meshes: ["@panoRing", "@panoGlass"] },
        {
            id: "panoramas", type: "geo.transform", when: "=panorama", repeat: "=4 * shownD", mesh: "@panoUnit",
            rotate: [0, "=floor(index / 2) % 2 == 0 ? 0 : 180", 0],
            at: ["=(index % 2 == 0 ? -1 : 1) * (Zc2 + lounge / 2)", "=H0 + floor(index / 4) * dH + sill", "=(floor(index / 2) % 2 == 0 ? 1 : -1) * (D2 - th / 2)"],
        },
        { id: "capFrameOuter", type: "curve.rect", output: false, width: "=capW + 0.16", height: "=capH + 0.16", radius: "=wr + 0.08", cornerSegments: 6 },
        { id: "capRing", type: "mesh.extrude", output: false, when: "=panorama", outline: "@capFrameOuter", holes: ["@capPano"], height: "=th + 0.08", bevel: 0.015, rotate: [-90, 0, 0], at: [0, "=capH / 2", "=(th + 0.08) / 2"], region: "frame" },
        { id: "capGlass", type: "mesh.extrude", output: false, when: "=panorama", outline: "@capPano", height: 0.03, rotate: [-90, 0, 0], at: [0, "=capH / 2", 0.015], region: "glass" },
        { id: "capUnit", type: "geo.join", output: false, meshes: ["@capRing", "@capGlass"] },
        {
            id: "capViewports", type: "geo.transform", when: "=panorama", repeat: "=2 * shownD", mesh: "@capUnit",
            rotate: [0, "=index % 2 == 0 ? -90 : 90", 0],
            at: ["=(index % 2 == 0 ? -1 : 1) * (L2 - th / 2)", "=H0 + floor(index / 2) * dH + capSill", 0],
        },
        // The hatch: a frame, a light ring and a leaf that slides toward +X.
        { id: "hatchFrameOuter", type: "curve.rect", output: false, width: "=hw + 0.3", height: "=hh + 0.3", radius: "=hr + 0.15", cornerSegments: 6 },
        { id: "hatchFrameOuterAt", type: "curve.transform", output: false, curve: "@hatchFrameOuter", offset: [0, "=hs + hh / 2"] },
        { id: "hatchFrame", type: "mesh.extrude", outline: "@hatchFrameOuterAt", holes: ["@hatchHoleAt"], height: "=th + 0.1", bevel: 0.02, rotate: [-90, 0, 0], at: [0, "=H0", "=D2 + 0.05"], region: "accent" },
        { id: "hatchGlowOuter", type: "curve.rect", output: false, width: "=hw + 0.1", height: "=hh + 0.1", radius: "=hr + 0.05", cornerSegments: 6 },
        { id: "hatchGlowOuterAt", type: "curve.transform", output: false, curve: "@hatchGlowOuter", offset: [0, "=hs + hh / 2"] },
        { id: "hatchGlow", type: "mesh.extrude", when: "=lightStrips", outline: "@hatchGlowOuterAt", holes: ["@hatchHoleAt"], height: 0.02, rotate: [-90, 0, 0], at: [0, "=H0", "=D2 + 0.07"], region: "lights" },
        { id: "hatchLeafShape", type: "curve.rect", output: false, width: "=hw + 0.12", height: "=hh + 0.12", radius: "=hr + 0.06", cornerSegments: 6 },
        { id: "hatchLeafAt", type: "curve.transform", output: false, curve: "@hatchLeafShape", offset: [0, "=hs + hh / 2 + 0.06"] },
        { id: "hatchLeaf", type: "mesh.extrude", outline: "@hatchLeafAt", height: 0.07, bevel: 0.02, rotate: [-90, 0, 0], at: ["=hatchOpen * (hw + 0.2)", "=H0", "=D2 + 0.16"], region: "accent" },
        { id: "hatchPort", type: "mesh.cylinder", radius: "=min(0.16, hw * 0.16)", height: 0.02, segments: 24, rotate: [90, 0, 0], at: ["=hatchOpen * (hw + 0.2)", "=H0 + hs + hh * 0.7", "=D2 + 0.175"], region: "glass" },
        { id: "hatchRail", type: "mesh.box", size: ["=2 * hw + 0.6", 0.08, 0.1], radius: 0.02, segments: 1, at: ["=hw / 2 + 0.1", "=H0 + hs + hh + 0.24", "=D2 + 0.1"], region: "accent" },
        // Canopy over the hatch with a light strip under its lip.
        { id: "awningSlab", type: "mesh.box", when: "=awning", size: ["=pW + 0.3", 0.1, "=pD + 0.2"], radius: 0.04, segments: 2, rotate: [6, 0, 0], at: [0, "=min(ySill + hh + 0.5, H0 + dH - 0.2)", "=D2 + (pD + 0.2) / 2"], region: "accent" },
        { id: "awningGlow", type: "mesh.box", when: "=awning && lightStrips", size: ["=pW + 0.1", 0.03, 0.05], at: [0, "=min(ySill + hh + 0.5, H0 + dH - 0.2) - 0.065", "=D2 + pD - 0.05"], region: "lights" },

        // ================= Boarding platform and stair =================
        { id: "platform", type: "mesh.box", size: ["=pW", 0.1, "=pD"], radius: 0.015, segments: 1, at: [0, "=ySill - 0.05", "=D2 + pD / 2 + 0.02"], region: "grating" },
        { id: "platformPosts", type: "mesh.cylinder", repeat: 2, radius: 0.07, height: "=ySill - 0.1 - ph", segments: 12, at: ["=(index == 0 ? -1 : 1) * (pW / 2 - 0.12)", "=ph", "=zP - 0.15"], region: "struts" },
        { id: "treadsB", type: "mesh.box", repeat: "=nB - 1", size: ["=pW - 0.3", 0.05, "=goB + 0.02"], at: [0, "=ySill - (index + 1) * rB - 0.025", "=zP + (index + 0.5) * goB"], region: "grating" },
        {
            id: "stringersRaw", type: "mesh.box", output: false, repeat: 2, size: [0.06, 0.24, "=(nB - 1) * goB / cos(slopeB) + 0.2"], rotate: ["=deg(slopeB)", 0, 0],
            at: ["=(index == 0 ? -1 : 1) * (pW / 2 - 0.12)", "=ySill - rB * nB / 2 - 0.12", "=zP + runB / 2"], region: "struts",
        },
        // Cut off square where they meet the ground.
        { id: "stringersB", type: "deform.clamp", mesh: "@stringersRaw", min: "=ph", region: "struts" },
        {
            id: "railsB", type: "mesh.box", repeat: 2, size: [0.05, 0.05, "=(nB - 1) * goB / cos(slopeB) + 0.1"], radius: 0.02, segments: 1, rotate: ["=deg(slopeB)", 0, 0],
            at: ["=(index == 0 ? -1 : 1) * (pW / 2 - 0.12)", "=ySill - rB * nB / 2 + 0.95", "=zP + runB / 2"], region: "struts",
        },
        { id: "railPostsB", type: "mesh.box", repeat: 4, size: [0.05, 1.0, 0.05], at: ["=(index % 2 == 0 ? -1 : 1) * (pW / 2 - 0.12)", "=index < 2 ? ySill + 0.5 - 0.05 : ph + rB + 0.5", "=index < 2 ? zP - 0.02 : zP + runB - 0.1"], region: "struts" },
        { id: "platformRails", type: "mesh.box", repeat: 2, size: [0.05, 0.05, "=pD - 0.05"], radius: 0.02, segments: 1, at: ["=(index == 0 ? -1 : 1) * (pW / 2 - 0.12)", "=ySill + 0.95", "=D2 + pD / 2"], region: "struts" },

        // ================= Legs =================
        // index % 2: front or back (mirrored); floor(index / 2): leg along X.
        { id: "legPath", type: "path.points", output: false, fillet: 0.35, filletSegments: 5, points: [[0, "=legAY + 0.1", "=legAZ - 0.05"], [0, "=kneeY", "=kneeZ"], [0, "=ph + 0.24", "=footZ"]] },
        { id: "legTube", type: "mesh.sweep", output: false, path: "@legPath", radius: 0.16, sides: 16, taper: 0.75 },
        { id: "pistonPath", type: "path.points", output: false, points: [[0, "=yb + 0.06", "=D2 - R * 0.9"], [0, "=kneeY + 0.05", "=kneeZ - 0.08"]] },
        { id: "pistonTube", type: "mesh.sweep", output: false, path: "@pistonPath", radius: 0.065, sides: 12, region: "piston" },
        { id: "kneeJoint", type: "mesh.sphere", output: false, radius: 0.22, segments: 16, rings: 8, at: [0, "=kneeY", "=kneeZ"] },
        { id: "footPad", type: "mesh.cone", output: false, bottomRadius: 0.56, topRadius: 0.24, height: 0.26, segments: 24, bevel: 0.02, at: [0, "=ph", "=footZ"] },
        { id: "legUnit", type: "geo.join", output: false, meshes: ["@legTube", "@kneeJoint", "@footPad"] },
        { id: "legUnitRegion", type: "geo.region", output: false, mesh: "@legUnit", region: "struts" },
        { id: "legFull", type: "geo.join", output: false, meshes: ["@legUnitRegion", "@pistonTube"] },
        {
            id: "legsPlaced", type: "geo.transform", repeat: "=nLeg * 2", mesh: "@legFull",
            scale: [1, 1, "=index % 2 == 0 ? 1 : -1"],
            at: ["=[-xLeg, xLeg, -xIn, xIn][floor(index / 2)]", 0, 0],
        },
        { id: "footLights", type: "mesh.torus", when: "=lightStrips", repeat: "=nLeg * 2", major: 0.54, minor: 0.03, segments: 32, sides: 6, at: ["=[-xLeg, xLeg, -xIn, xIn][floor(index / 2)]", "=ph + 0.03", "=(index % 2 == 0 ? 1 : -1) * footZ"], region: "lights" },

        // ================= Exterior details =================
        // Structural rings at every cabin wall and at both ends of the lounges.
        { id: "bandOuter", type: "curve.points", output: false, closed: true, points: section("-0.07", false) },
        { id: "bandCut", type: "curve.points", output: false, closed: true, points: sectionU("-0.07", "0.02") },
        { id: "bandInner", type: "curve.points", output: false, closed: true, points: section("0.02", false) },
        {
            id: "hullBands", type: "mesh.extrude", when: "=bands", repeat: "=nC + 3", outline: { if: "=cut", then: "@bandCut", else: "@bandOuter" },
            holes: { if: "=cut", then: [], else: ["@bandInner"] }, height: 0.16, bevel: 0.025, rotate: [-90, -90, 0],
            at: ["=(index <= nC ? -Zc2 + index * cw : (index == nC + 1 ? -Zc2 - lounge + 0.1 : Zc2 + lounge - 0.1)) - 0.08", 0, 0], region: "accent",
        },
        // Light strips along the shoulder lines, and nav lights at the ends.
        { id: "hullStrips", type: "mesh.box", when: "=lightStrips", repeat: "=roofShown ? 4 : 2", size: ["=innerL - 0.2", 0.05, 0.05], at: [0, "=index < 2 ? H0 - 0.05 : yC + 0.05", "=(index % 2 == 0 ? 1 : -1) * (D2 + 0.005)"], region: "lights" },
        { id: "navLights", type: "mesh.sphere", when: "=roofShown", repeat: 4, radius: 0.11, segments: 14, rings: 7, at: ["=(index < 2 ? -1 : 1) * (L2 - 0.4)", "=yt + 0.02", "=(index % 2 == 0 ? 1 : -1) * (D2 - R * 0.6)"], region: "=index % 2 == 0 ? 'navGreen' : 'navRed'" },

        // ================= Observation dome =================
        { id: "domeWell", type: "mesh.lathe", when: "=hasDome", profile: [["=rc", "=yC - 0.02"], ["=rc + 0.05", "=yC - 0.02"], ["=rc + 0.05", "=yt"], ["=rc", "=yt"], ["=rc", "=yC - 0.02"]], segments: 48, at: ["=xDome", 0, 0], region: "accent" },
        { id: "domeCollar", type: "mesh.lathe", when: "=hasDome", profile: [["=rc - 0.02", "=yt"], ["=rc + 0.26", "=yt"], ["=rc + 0.26", "=yt + 0.16"], ["=rc + 0.12", "=yt + 0.3"], ["=rc - 0.02", "=yt + 0.3"], ["=rc - 0.02", "=yt"]], segments: 48, smoothAngle: 30, at: ["=xDome", 0, 0], region: "accent" },
        {
            id: "domeGlass", type: "mesh.lathe", when: "=hasDome",
            profile: [...dome("rc + 0.015", "domeH + 0.015"), ...dome("rc - 0.015", "domeH - 0.015").reverse(), ["=rc + 0.015", 0]], segments: 48, at: ["=xDome", "=yt + 0.3", 0], region: "glass",
        },
        { id: "domeRibPath", type: "path.points", output: false, points: dome("rc + 0.03", "domeH + 0.03", 12).map(([u, v]) => [u, v, 0] as [string, string, number]).slice(0, 12) },
        { id: "domeRib", type: "mesh.sweep", output: false, when: "=hasDome", path: "@domeRibPath", radius: 0.035, sides: 8 },
        { id: "domeRibs", type: "geo.transform", when: "=hasDome", repeat: 8, mesh: "@domeRib", rotate: [0, "=index * 45 + 22.5", 0], at: ["=xDome", "=yt + 0.3", 0], region: "frame" },
        { id: "domeCrown", type: "mesh.cylinder", when: "=hasDome", radius: "=max(0.12, rc * 0.14)", height: 0.08, segments: 24, bevel: 0.02, at: ["=xDome", "=yt + 0.3 + domeH - 0.02", 0], region: "frame" },
        { id: "domeBeacon", type: "mesh.sphere", when: "=hasDome && lightStrips", radius: 0.07, segments: 12, rings: 6, at: ["=xDome", "=yt + 0.3 + domeH + 0.1", 0], region: "navRed" },

        // ================= Roof gear =================
        { id: "solarMast", type: "mesh.cylinder", repeat: "=nSol", radius: 0.07, height: 0.95, segments: 12, at: ["=-Zc2 + (index + 0.5) * solPitch", "=yt", 0], region: "struts" },
        { id: "solarPanel", type: "mesh.box", output: false, size: ["=solW", 0.04, "=solD"], radius: 0.01, segments: 1, region: "solar" },
        { id: "solarFrameX", type: "mesh.box", output: false, repeat: 2, size: ["=solW + 0.06", 0.06, 0.05], at: [0, 0, "=(index == 0 ? -1 : 1) * solD / 2"], region: "frame" },
        { id: "solarFrameZ", type: "mesh.box", output: false, repeat: 3, size: [0.05, 0.06, "=solD"], at: ["=(index - 1) * solW / 2", 0, 0], region: "frame" },
        { id: "solarUnit", type: "geo.join", output: false, meshes: ["@solarPanel", "@solarFrameX", "@solarFrameZ"] },
        { id: "solarArrays", type: "geo.transform", repeat: "=nSol", mesh: "@solarUnit", rotate: [22, 0, 0], at: ["=-Zc2 + (index + 0.5) * solPitch", "=yt + 1.0", 0] },
        // Radiator wings: a panel per cabin cell, hinged out from the back crown shoulder.
        { id: "radPanels", type: "mesh.box", repeat: "=nFins", size: ["=cw - 0.35", 1.1, 0.05], radius: 0.015, segments: 1, rotate: [-40, 0, 0], at: ["=-Zc2 + (index + 0.5) * cw", "=yC + (R + 0.62) * sin(rad(50))", "=-(D2 - R) - (R + 0.62) * cos(rad(50))"], region: "radiator" },
        { id: "radPipes", type: "mesh.box", repeat: "=nFins * 4", size: ["=cw - 0.4", 0.035, 0.07], rotate: [-40, 0, 0], at: ["=-Zc2 + (floor(index / 4) + 0.5) * cw", "=yC + (R + 0.2 + (index % 4) * 0.28) * sin(rad(50))", "=-(D2 - R) - (R + 0.2 + (index % 4) * 0.28) * cos(rad(50)) - 0.02"], region: "struts" },
        { id: "radHinges", type: "mesh.cylinder", when: "=nFins > 0", radius: 0.07, height: "=2 * Zc2 - 0.2", segments: 12, rotate: [0, 0, -90], at: ["=-Zc2 + 0.1", "=yC + (R + 0.02) * sin(rad(50))", "=-(D2 - R) - (R + 0.02) * cos(rad(50))"], region: "struts" },
        { id: "antMast", type: "mesh.cylinder", when: "=antenna && roofShown", radius: 0.08, height: 1.4, segments: 12, at: ["=xAnt", "=yt", "=-(D2 - R) * 0.45"], region: "struts" },
        { id: "dishProfile", type: "curve.points", output: false, points: [[0, 0], [0.25, 0.03], [0.5, 0.12], [0.75, 0.27], [0.9, 0.39], [0.9, 0.42], [0.74, 0.31], [0.49, 0.16], [0.24, 0.06], [0, 0.03]] },
        { id: "dish", type: "mesh.lathe", output: false, profile: "@dishProfile", segments: 32 },
        { id: "dishFeed", type: "mesh.cylinder", output: false, radius: 0.025, height: 0.7, segments: 8 },
        { id: "dishHorn", type: "mesh.cone", output: false, bottomRadius: 0.05, topRadius: 0.09, height: 0.12, segments: 12, at: [0, 0.7, 0] },
        { id: "dishUnit", type: "geo.join", output: false, meshes: ["@dish", "@dishFeed", "@dishHorn"] },
        { id: "antDish", type: "geo.transform", when: "=antenna && roofShown", mesh: "@dishUnit", rotate: [45, 30, 0], at: ["=xAnt", "=yt + 1.45", "=-(D2 - R) * 0.45"], region: "accent" },
        { id: "antBeacon", type: "mesh.sphere", when: "=antenna && roofShown && lightStrips", radius: 0.06, segments: 12, rings: 6, at: ["=xAnt", "=yt + 1.42", "=-(D2 - R) * 0.45"], region: "navRed" },

        // ================= Decks =================
        { id: "deck0", type: "mesh.box", size: ["=innerL", 0.14, "=2 * zi"], at: [0, "=H0 - 0.07", 0], region: "floors" },
        { id: "slabOutline", type: "curve.points", output: false, closed: true, points: [["=-Zc2 - lounge", "=-zi"], ["=Zc2 + lounge", "=-zi"], ["=Zc2 + lounge", "=zi"], ["=-Zc2 - lounge", "=zi"]] },
        { id: "stairwell", type: "curve.circle", output: false, radius: "=holeR", segments: 40, center: [0, "=zS"] },
        { id: "slab1", type: "mesh.extrude", when: "=shownD > 1", outline: "@slabOutline", holes: ["@stairwell"], height: "=s - 0.03", at: [0, "=H0 + dH - s", 0], region: "ceiling" },
        { id: "boards1", type: "mesh.extrude", when: "=shownD > 1", outline: "@slabOutline", holes: ["@stairwell"], height: 0.03, at: [0, "=H0 + dH - 0.03", 0], region: "floors" },
        { id: "topCeiling", type: "mesh.extrude", when: "=roofShown", outline: "@slabOutline", holes: { if: "=cupola", then: ["@domeHole"], else: [] }, height: 0.06, at: [0, "=yC", 0], region: "ceiling" },

        // ================= Cabins =================
        // Corridor wall segments, one per cell, side and deck, each with a chamfered doorway; the
        // airlock vestibule (front, lower deck) and the stair core (back, with two decks) stay open.
        { id: "corrWall", type: "curve.points", output: false, closed: true, points: [["=-cw / 2", 0], ["=-dw / 2", 0], ["=-dw / 2", "=dh - dc"], ["=-dw / 2 + dc", "=dh"], ["=dw / 2 - dc", "=dh"], ["=dw / 2", "=dh - dc"], ["=dw / 2", 0], ["=cw / 2", 0], ["=cw / 2", "=dH - s"], ["=-cw / 2", "=dH - s"]] },
        { id: "corrWallTop", type: "curve.points", output: false, closed: true, points: [["=-cw / 2", 0], ["=-dw / 2", 0], ["=-dw / 2", "=dh - dc"], ["=-dw / 2 + dc", "=dh"], ["=dw / 2 - dc", "=dh"], ["=dw / 2", "=dh - dc"], ["=dw / 2", 0], ["=cw / 2", 0], ["=cw / 2", "=dH"], ["=-cw / 2", "=dH"]] },
        {
            id: "corridorWalls", type: "mesh.extrude", repeat: "=2 * nC * shownD",
            keep: "=!(index % nC == kC && ((floor(index / nC) % 2 == 0 && floor(index / (2 * nC)) == 0) || (floor(index / nC) % 2 == 1 && decks > 1)))",
            outline: { if: "=floor(index / (2 * nC)) < decks - 1", then: "@corrWall", else: "@corrWallTop" },
            height: "=pt", rotate: [-90, "=floor(index / nC) % 2 == 0 ? 0 : 180", 0],
            at: ["=-Zc2 + (index % nC + 0.5) * cw", "=H0 + floor(index / (2 * nC)) * dH", "=(floor(index / nC) % 2 == 0 ? 1 : -1) * (cz + pt)"], region: "interior",
        },
        { id: "doorFrameShape", type: "curve.points", output: false, closed: true, points: [["=-dw / 2 - df", 0], ["=-dw / 2 - df", "=dh - dc + 0.414 * df"], ["=-dw / 2 + dc - 0.414 * df", "=dh + df"], ["=dw / 2 - dc + 0.414 * df", "=dh + df"], ["=dw / 2 + df", "=dh - dc + 0.414 * df"], ["=dw / 2 + df", 0], ["=dw / 2", 0], ["=dw / 2", "=dh - dc"], ["=dw / 2 - dc", "=dh"], ["=-dw / 2 + dc", "=dh"], ["=-dw / 2", "=dh - dc"], ["=-dw / 2", 0]] },
        {
            id: "doorFrames", type: "mesh.extrude", repeat: "=2 * nC * shownD",
            keep: "=!(index % nC == kC && ((floor(index / nC) % 2 == 0 && floor(index / (2 * nC)) == 0) || (floor(index / nC) % 2 == 1 && decks > 1)))",
            outline: "@doorFrameShape", height: "=pt + 0.05", rotate: [-90, "=floor(index / nC) % 2 == 0 ? 0 : 180", 0],
            at: ["=-Zc2 + (index % nC + 0.5) * cw", "=H0 + floor(index / (2 * nC)) * dH", "=(floor(index / nC) % 2 == 0 ? 1 : -1) * (cz + pt + 0.025)"], region: "accent",
        },
        {
            // Cabin walls at every cell boundary, front and back, every deck.
            id: "cabinWalls", type: "mesh.box", repeat: "=2 * (nC + 1) * shownD",
            size: ["=pt", "=floor(index / (2 * (nC + 1))) < decks - 1 ? dH - s : dH", "=cd"],
            at: ["=-Zc2 + (index % (nC + 1)) * cw", "=H0 + floor(index / (2 * (nC + 1))) * dH + (floor(index / (2 * (nC + 1))) < decks - 1 ? dH - s : dH) / 2", "=(floor(index / (nC + 1)) % 2 == 0 ? 1 : -1) * zCab"], region: "interior",
        },
        // Corridor ceiling light strips.
        { id: "corridorLights", type: "mesh.box", when: "=lightStrips", repeat: "=2 * shownD", keep: "=floor(index / 2) < shownD - 1 || roofShown", size: ["=innerL - 0.4", 0.03, 0.08], at: [0, "=H0 + floor(index / 2) * dH + (floor(index / 2) < decks - 1 ? dH - s : dH) - 0.015", "=(index % 2 == 0 ? 1 : -1) * (cz - 0.12)"], region: "lights" },

        // ================= Spiral stair =================
        { id: "treadShape", type: "curve.sector", output: false, inner: 0.1, outer: "=rs", start: "=-da / 2 - 2", end: "=da / 2 + 2", radius: 0.02, segments: 6 },
        { id: "spiralTreads", type: "mesh.extrude", when: "=stairShown", repeat: "=nT", outline: "@treadShape", height: 0.05, rotate: [0, "=-(th0 + index * da)", 0], at: [0, "=H0 + (index + 1) * rh - 0.05", "=zS"], region: "stair" },
        { id: "spiralColumn", type: "mesh.cylinder", when: "=stairShown", radius: 0.11, height: "=dH + 1.0", segments: 20, at: [0, "=H0", "=zS"], region: "stair" },
        { id: "spiralRailPath", type: "path.points", output: false, smooth: 3, points: spiralRail("rs - 0.04") },
        { id: "spiralRail", type: "mesh.sweep", when: "=stairShown", path: "@spiralRailPath", radius: 0.03, sides: 8, at: [0, "=H0", "=zS"], region: "stair" },
        {
            id: "spiralBalusters", type: "mesh.cylinder", when: "=stairShown", repeat: "=nT", radius: 0.015, height: 0.9, segments: 6,
            at: ["=(rs - 0.04) * cos(rad(th0 + index * da))", "=H0 + (index + 1) * rh", "=zS + (rs - 0.04) * sin(rad(th0 + index * da))"], region: "stair",
        },
        // Guard around the stairwell on the upper deck, open where the stair arrives.
        { id: "guardPath", type: "path.arc", output: false, radius: "=holeR + 0.05", start: "=thEnd + 40", end: "=thEnd + 345 - da", segments: 36 },
        { id: "guardRail", type: "mesh.sweep", when: "=stairShown", path: "@guardPath", radius: 0.03, sides: 8, at: [0, "=H0 + dH + 1.0", "=zS"], region: "stair" },
        {
            id: "guardPosts", type: "mesh.cylinder", when: "=stairShown", repeat: 12, radius: 0.015, height: 1.0, segments: 6,
            at: ["=(holeR + 0.05) * cos(rad(thEnd + 40 + index * (305 - da) / 11))", "=H0 + dH", "=zS + (holeR + 0.05) * sin(rad(thEnd + 40 + index * (305 - da) / 11))"], region: "stair",
        },
    ],
    limits: { maxSize: 42, minSize: 6, maxTriangles: 300000 },
};

export default habLodgeDef;
