import type { ObjectDef } from "../mesha_object";

// A street car (tram): one to three body sections on bogies, a driver's cab at each end, and a
// full interior. Elevation of one section (the car runs along X, its front side faces +Z):
//
//        cab |  bay  |  bay  |  bay  |  bay  |  bay  | cab       A section is `bays` cells of
//     .------+-------+-------+-------+-------+-------+------.    `bayWidth`: window bays with
//    / glass | [win] | door  | [win] | door  | [win] | glass \   seats, and door bays. Doors are
//   |  dash  |       | |  |  |       | |  |  |       |  dash  |  spread between the end bays (the
//   '--------+--oo---+-------+-------+-------+---oo--+--------'  bogies sit under those), or at
//                bogie                           bogie            the ends with the bogies inboard.
//
// The cabs are built once in nose-local coordinates (the partition at x = 0, the tip toward +X)
// and placed at both ends, the far one mirrored. Their plan is straight cab sides then a
// superellipse nose; dash, raked windscreen band, letterboard and roof are stacked layers of that
// plan, so every livery line runs unbroken round the nose. Side walls use the house's convention:
// rotate [-90, 0, 0] runs an outline's (u, v) along (+X, up) with its thickness toward -Z, and
// [-90, 180, 0] the same on the back side. The roof is a stack of thin lofts stepping inward along
// a quarter circle, smoothed into one curved shell.

const NOSE_N = 16;
const ROOF_K = 5;

/** The nose plan's frame, inset by `d` (an outline that much inside the skin) and with the tip pulled back by `r`. */
const frame = (d: string, r: string) => {
    const hwd = `(hw - (${d}))`;
    const tip = `(cabL - (${d}) - (${r}))`;
    const nd = `clamp((nL - (${r})) * ${hwd} / hw, 0.05, ${tip} - 0.05)`;
    return { hwd, nd, xs: `(${tip} - ${nd})` };
};
/** "=expr" points of the nose plan (x, z) from the partition on +Z, round the tip, back to the partition on -Z. */
const nosePlan = (d: string, r = "0"): [string, string][] => {
    const { hwd, nd, xs } = frame(d, r);
    const pts: [string, string][] = [["=0", `=${hwd}`]];
    for (let k = 0; k <= NOSE_N; k++) {
        const a = Math.PI / 2 - (Math.PI * k) / NOSE_N;
        const c = Math.max(0, Math.cos(a)).toFixed(6), s = Math.abs(Math.sin(a)).toFixed(6), sign = a < -1e-9 ? "-" : "";
        pts.push([`=${xs} + ${nd} * pow(${c}, 2 / ne)`, `=${sign}${hwd} * pow(${s}, 2 / ne)`]);
    }
    pts.push(["=0", `=-${hwd}`]);
    return pts;
};
/** A U-shaped shell of the nose between two insets: the cab's dash, glazing and letterboard. */
const noseShell = (outer: string, inner: string, r = "0"): [string, string][] => [...nosePlan(outer, r), ...nosePlan(inner, r).reverse()];
/** x of the nose skin (inset d, pulled back r) at lateral position z. */
const noseX = (z: string, d = "0", r = "0"): string => {
    const { hwd, nd, xs } = frame(d, r);
    return `(${xs} + ${nd} * pow(max(0, 1 - pow(min(1, abs(${z}) / ${hwd}), ne)), 1 / ne))`;
};
/** A strip hugging the nose skin between z = -w/2 and w/2, `out` proud of it and `back` behind it: signs, bumpers. */
const noseStrip = (w: string, out: string, back: string, d = "0", r = "0", n = 10): [string, string][] => {
    const zs = Array.from({ length: n + 1 }, (_, k) => `(${w}) * (${k / n} - 0.5)`);
    return [...zs.map(z => [`=${noseX(z, d, r)} + ${out}`, `=${z}`] as [string, string]), ...zs.reverse().map(z => [`=${noseX(z, d, r)} - ${back}`, `=${z}`] as [string, string])];
};
/** Roof slice k: inset and height on a quarter circle of radius Rr. */
const roofD = (k: string) => `Rr * (1 - cos(rad(90 * (${k}) / ${ROOF_K})))`;
const roofH = (k: string) => `Rr * sin(rad(90 * (${k}) / ${ROOF_K}))`;
const rect = (x0: string, x1: string, hz: string): [string, string][] => [[`=${x0}`, `=${hz}`], [`=${x1}`, `=${hz}`], [`=${x1}`, `=-(${hz})`], [`=${x0}`, `=-(${hz})`]];

// Cells: repeat over every (cell, side), and over (cell, side, two of something).
/** Section-local bay of global cell i. */
const bayOf = (i: string) => `(${i}) % bays`;
const cellX = (i: string) => `(-xE + floor((${i}) / bays) * (secLen + gapJ) + ((${i}) % bays + 0.5) * cw)`;
const doorBay = (j: string) => `(doorPlacement == 'ends' ? (${j} == 0 || ${j} == bays - 1) : (${j} == dA || ${j} == dB || ${j} == dC))`;
/** Cell i on side k (0 front, 1 back) has a doorway. */
const isDoor = (i: string, k: string) => `(${doorBay(bayOf(i))} && (${k} == 0 || doorSides == 'both'))`;
const isBogie = (i: string) => `(${bayOf(i)} == bj0 || ${bayOf(i)} == bays - 1 - bj0)`;
// index = 2 i + side
const C2 = { i: "floor(index / 2)", k: "(index % 2)", s: "(index % 2 == 0 ? 1 : -1)" };
// index = 4 i + 2 side + m
const C4 = { i: "floor(index / 4)", k: "(floor(index / 2) % 2)", s: "(floor(index / 2) % 2 == 0 ? 1 : -1)", m: "(index % 2)" };

export const streetCarDef: ObjectDef = {
    id: "transport.street_car",
    name: "Street Car",
    category: "Transport",
    tags: ["street car", "streetcar", "tram", "trolley", "trolley car", "tramcar", "light rail", "lrv", "railcar", "pcc", "vehicle", "transit", "public transport", "rail", "train", "interior", "city"],
    description: "A tram from heritage trolley to articulated light rail: one to three sections on bogies, raked or bluff noses with a driver's cab at each end, plug, sliding or folding doors, see-through glazing and a fitted interior of seats, poles and lights, on an optional stretch of street or ballasted track.",
    featured: ["sections", "bays", "bluntness", "rake", "doorStyle", "doorOpen", "seating", "collector", "track", "bodyFinish", "lowerFinish", "glassFinish"],
    groups: [
        { id: "body", label: "Body" },
        { id: "ends", label: "Cabs and noses" },
        { id: "windows", label: "Windows" },
        { id: "doors", label: "Doors" },
        { id: "interior", label: "Interior" },
        { id: "gear", label: "Running gear and roof" },
        { id: "view", label: "Inspect" },
        { id: "materials", label: "Livery" },
        { id: "interiorMaterials", label: "Interior materials" },
    ],
    params: [
        // --- Body ---
        { id: "sections", label: "Sections", type: "int", default: 1, min: 1, max: 3, group: "body", description: "Articulated body sections, joined by bellows." },
        { id: "bays", label: "Bays per section", type: "int", default: 5, min: 4, max: 9, group: "body" },
        { id: "bayWidth", label: "Bay width", type: "number", default: 2.05, min: 1.75, max: 2.6, unit: "m", group: "body", description: "Each bay holds a window and a pair of seat rows, or a doorway; a bogie fits under one." },
        { id: "width", label: "Body width", type: "number", default: 2.4, min: 2.2, max: 2.65, unit: "m", group: "body" },
        { id: "floorHeight", label: "Floor height", type: "number", default: 0.38, min: 0.3, max: 1.0, unit: "m", group: "body", description: "Above the rails. Low floors lift the seats over the wheels onto podiums; high floors get boarding steps." },
        { id: "interiorHeight", label: "Interior height", type: "number", default: 2.25, min: 2.05, max: 2.6, unit: "m", group: "body" },
        { id: "skirt", label: "Skirts", type: "number", default: 0.65, min: 0, max: 1, group: "body", description: "How far the body sides drop over the bogies." },
        { id: "roofRadius", label: "Roof curve", type: "number", default: 0.3, min: 0.12, max: 0.5, unit: "m", group: "body" },
        // --- Cabs ---
        { id: "cabLength", label: "Cab length", type: "number", default: 2.2, min: 1.7, max: 3.2, unit: "m", group: "ends" },
        { id: "noseLength", label: "Nose length", type: "number", default: 1.1, min: 0.25, max: "=cabLength - 0.15", unit: "m", group: "ends", description: "The curved part of the cab, in plan." },
        { id: "bluntness", label: "Bluntness", type: "number", default: 0.35, min: 0, max: 1, group: "ends", description: "From a pointed, bullet nose to a bluff, square-cornered end." },
        { id: "rake", label: "Windscreen rake", type: "number", default: 0.4, min: 0, max: "=noseLength * 0.7", unit: "m", group: "ends", description: "How far the top of the windscreen leans back." },
        { id: "windscreen", label: "Windscreen", type: "enum", default: "panoramic", options: ["panoramic", "split", "three"], optionLabels: ["Panoramic", "Split", "Three-pane"], group: "ends" },
        { id: "cabStyle", label: "Driving desk", type: "enum", default: "modern", options: ["modern", "classic"], optionLabels: ["Console and screens", "Controller and brake wheel"], group: "ends" },
        { id: "cabPartition", label: "Cab partition", type: "bool", default: true, group: "ends" },
        { id: "mirrors", label: "Mirrors", type: "bool", default: true, group: "ends" },
        { id: "bumper", label: "Bumper strip", type: "bool", default: true, group: "ends" },
        { id: "lifeguard", label: "Lifeguard tray", type: "bool", default: false, group: "ends", description: "The slatted tray hung low under a heritage car's nose." },
        { id: "destinationSign", label: "Destination sign", type: "bool", default: true, group: "ends" },
        // --- Windows ---
        { id: "sill", label: "Window sill", type: "number", default: 0.78, min: 0.55, max: 1.0, unit: "m", group: "windows", description: "Above the floor." },
        { id: "windowHeight", label: "Window height", type: "number", default: 1.05, min: 0.55, max: "=interiorHeight - sill - 0.28", unit: "m", group: "windows" },
        { id: "windowShare", label: "Window width", type: "number", default: 0.8, min: 0.5, max: 0.9, group: "windows", description: "As a share of the bay." },
        { id: "windowStyle", label: "Window shape", type: "enum", default: "rounded", options: ["rounded", "arched", "square"], optionLabels: ["Rounded", "Arched", "Square"], group: "windows" },
        { id: "windowRounding", label: "Corner rounding", type: "number", default: 0.12, min: 0.02, max: 0.3, unit: "m", group: "windows", visibleIf: "=windowStyle == 'rounded'" },
        { id: "transoms", label: "Transom lights", type: "bool", default: false, group: "windows", description: "Small upper lights above the windows, where the letterboard is deep enough." },
        // --- Doors ---
        { id: "doorPlacement", label: "Door placement", type: "enum", default: "spread", options: ["spread", "ends"], optionLabels: ["Between the bogies", "At the ends"], group: "doors" },
        { id: "doors", label: "Doors per side", type: "int", default: 2, min: 1, max: "=min(3, floor((bays - 1) / 2))", group: "doors", visibleIf: "=doorPlacement == 'spread'", description: "Per section." },
        { id: "doorSides", label: "Door sides", type: "enum", default: "both", options: ["both", "one"], optionLabels: ["Both sides", "One side"], group: "doors" },
        { id: "doorWidth", label: "Door width", type: "number", default: 1.3, min: 0.8, max: "=min(1.45, bayWidth - 0.35)", unit: "m", group: "doors" },
        { id: "doorStyle", label: "Doors", type: "enum", default: "plug", options: ["plug", "sliding", "folding"], optionLabels: ["Plug (swing out and slide)", "Sliding (inside)", "Folding (inward)"], group: "doors" },
        { id: "doorOpen", label: "Doors open", type: "number", default: 1, min: 0, max: 1, group: "doors" },
        // --- Interior ---
        { id: "seating", label: "Seating", type: "enum", default: "facing", options: ["facing", "forward", "longitudinal"], optionLabels: ["Facing bays", "All forward", "Benches along the sides"], group: "interior" },
        { id: "aisle", label: "Aisle width", type: "number", default: 0.62, min: 0.5, max: "=min(0.9, width - 1.08)", unit: "m", group: "interior", visibleIf: "=seating != 'longitudinal'" },
        { id: "straps", label: "Hand straps", type: "bool", default: true, group: "interior" },
        { id: "adCards", label: "Advertising cards", type: "bool", default: true, group: "interior" },
        // --- Running gear and roof ---
        { id: "collector", label: "Current collector", type: "enum", default: "pantograph", options: ["pantograph", "trolley", "none"], optionLabels: ["Pantograph", "Trolley poles", "None (battery)"], group: "gear" },
        { id: "collectorUp", label: "Collector raised", type: "number", default: 0.7, min: 0, max: 1, group: "gear", visibleIf: "=collector != 'none'" },
        { id: "roofPods", label: "Roof equipment", type: "bool", default: true, group: "gear" },
        { id: "wheelSize", label: "Wheel radius", type: "number", default: 0.31, min: 0.26, max: "=clamp((floorHeight + 0.3) / 2, 0.26, 0.42)", unit: "m", group: "gear", description: "Low floors take small wheels, so the podiums over them stay low." },
        { id: "track", label: "Track", type: "enum", default: "street", options: ["street", "ballast", "none"], optionLabels: ["Street (paved)", "Ballasted", "None"], group: "gear" },
        { id: "stripe", label: "Livery stripe", type: "bool", default: true, group: "materials" },
        // --- Inspect ---
        { id: "roofVisible", label: "Show roof", type: "bool", default: true, group: "view", variation: 0, description: "Lift the roof, ceilings and roof gear off to look inside." },
        // --- Livery ---
        { id: "bodyFinish", label: "Body", type: "material", default: "paint.white", materials: ["paint", "metal.aluminum", "metal.steel", "composite"], group: "materials" },
        { id: "lowerFinish", label: "Lower body", type: "material", default: "paint.crimson", materials: ["paint", "metal.aluminum", "metal.steel", "composite"], group: "materials" },
        { id: "roofFinish", label: "Roof", type: "material", default: "paint.silver", materials: ["paint", "metal.aluminum", "composite"], group: "materials" },
        { id: "accentFinish", label: "Stripe", type: "material", default: "paint.black", materials: ["paint", "metal.chrome", "metal.brass", "metal.gold"], group: "materials", visibleIf: "=stripe" },
        { id: "doorFinish", label: "Doors", type: "material", default: "paint.crimson", materials: ["paint", "metal.aluminum", "metal.steel", "wood.teak", "wood.oak", "composite"], group: "materials" },
        { id: "trimFinish", label: "Frames and trim", type: "material", default: "rubber.black", materials: ["rubber.black", "plastic.black", "metal.chrome", "metal.brass", "metal.aluminum", "metal.black", "paint"], group: "materials" },
        { id: "glassFinish", label: "Glazing", type: "material", default: "glass.window", materials: ["glass.window", "glass.windowTinted", "glass.windowBronze", "glass.windowGreen", "glass.clear", "glass.tinted"], group: "materials" },
        { id: "signFinish", label: "Destination sign", type: "material", default: "glow.amber", materials: ["glow"], group: "materials", visibleIf: "=destinationSign" },
        // --- Interior materials ---
        { id: "seatFinish", label: "Seats", type: "material", default: "fabric.moquette", materials: ["fabric", "leather", "wood.teak", "wood.oak", "plastic"], group: "interiorMaterials" },
        { id: "seatFrameFinish", label: "Seat frames", type: "material", default: "metal.steel", materials: ["metal", "plastic", "paint"], group: "interiorMaterials" },
        { id: "floorFinish", label: "Floor", type: "material", default: "rubber.floor", materials: ["rubber.floor", "wood", "composite.grey", "stone.slate"], group: "interiorMaterials" },
        { id: "interiorFinish", label: "Linings and ceiling", type: "material", default: "plastic.white", materials: ["plastic", "paint", "wood", "composite"], group: "interiorMaterials" },
        { id: "poleFinish", label: "Grab poles", type: "material", default: "paint.signal", materials: ["paint", "metal.chrome", "metal.steel", "metal.brass"], group: "interiorMaterials" },
        { id: "lightFinish", label: "Cabin lights", type: "material", default: "glow.warmWhite", materials: ["glow.warmWhite", "glow.white", "glow.candle", "glow.amber", "glow.cyan"], group: "interiorMaterials" },
    ],
    derived: {
        // Heights: rails, floor, belt, windows, eaves. The track lifts everything onto its rails.
        yR: "=track == 'street' ? 0.16 : track == 'ballast' ? 0.51 : 0.025",
        yF: "=yR + floorHeight", yE: "=yF + interiorHeight",
        yBelt: "=yF + sill", yW0: "=yBelt + 0.05", yW1: "=yW0 + windowHeight",
        yCT: "=min(yW1 + 0.06, yE - 0.12)",
        ySk: "=lerp(yF - 0.18, yR + 0.1, skirt)",
        hL: "=yBelt - ySk", hU: "=yE - yBelt", vF: "=yF - ySk",
        Rr: "=roofRadius", yTop: "=yE + roofRadius",
        th: 0.06,
        // Plan.
        hw: "=width / 2", hwi: "=width / 2 - th",
        cw: "=bayWidth", secLen: "=bays * bayWidth", gapJ: 0.6, S: "=sections",
        Ltot: "=S * secLen + (S - 1) * gapJ", xE: "=Ltot / 2",
        cabL: "=cabLength", nL: "=noseLength", ne: "=lerp(1.8, 7, bluntness)",
        // Windows.
        ww: "=min(bayWidth * windowShare, bayWidth - 0.24)", wh: "=windowHeight",
        wr: "=windowStyle == 'rounded' ? min(windowRounding, ww / 2, wh / 2) : 0.015",
        archRise: "=min(ww / 2, wh * 0.4)",
        tH: "=min(0.3, yE - yW1 - 0.2)", tOK: "=transoms && tH >= 0.12",
        // Doors: which bays, how big, and how high a step.
        dA: "=1 + floor(0.5 * (bays - 2) / doors)",
        dB: "=doors >= 2 ? 1 + floor(1.5 * (bays - 2) / doors) : -9",
        dC: "=doors >= 3 ? 1 + floor(2.5 * (bays - 2) / doors) : -9",
        dw: "=doorWidth", dh: "=min(2.0, interiorHeight - 0.12)", lw: "=doorWidth / 2 - 0.005",
        dTop: "=yF + dh - yBelt",
        nSteps: "=yF - yR > 0.5 ? ceil((yF - yR - 0.2) / 0.3) - 1 : 0", stepRise: "=(yF - yR) / (nSteps + 1)",
        // Seats.
        lon: "=seating == 'longitudinal'",
        sw: "=hwi - 0.04 - aisle / 2", zSeat: "=aisle / 2 + sw / 2", nCush: "=sw > 0.85 ? 2 : 1",
        zPole: "=lon ? hwi - 0.62 : aisle / 2 + 0.03",
        // Running gear: wheels, bogie bays, podiums over the wheels on low floors.
        r: "=wheelSize", g2: 0.7175,
        wb: "=clamp(bayWidth - 2 * wheelSize - 0.15, 1.0, 1.9)",
        bj0: "=doorPlacement == 'ends' ? 1 : 0",
        podH: "=max(0, yR + 2 * wheelSize + 0.07 - yF)",
        zPod0: "=lon ? hwi - 0.82 : aisle / 2",
        seatY: "=0.45",
        lowGear: "=yR + wheelSize + 0.08 < yF - 0.13",
        // Cab interior (nose-local): desk and driver's seat, kept inside the nose.
        hwN: "=hw - th",
        tipI: "=cabL - th",
        ndI: "=clamp(nL * (hw - th) / hw, 0.05, cabL - th - 0.05)", xsI: "=cabL - th - ndI",
        xd: "=clamp(xsI + 0.4 * ndI, 1.15, tipI - 0.2)",
        dhw: "=clamp((xd <= xsI ? hwN : hwN * pow(max(0, 1 - pow((xd - xsI) / ndI, ne)), 1 / ne)) - 0.1, 0.25, 0.85)",
        // Nose details.
        lbH: "=yE - yCT", signH: "=min(0.24, lbH - 0.08)", signW: "=min(1.3, hw)",
        yLamp: "=max(ySk + 0.17, yBelt - 0.32)",
        // Roof gear.
        kP: "=floor(S / 2)", xP: "=-xE + kP * (secLen + gapJ) + secLen / 2",
        panH: "=lerp(0.35, 1.85, collectorUp)", panL: 1.15,
        panKx: "=-sqrt(panL * panL - panH * panH / 4)",
        poleLen: "=min(5.5, xE + cabL * 0.4)", poleA: "=lerp(4, 26, collectorUp)",
        roofShown: "=roofVisible",
        // Track.
        Lt: "=Ltot + 2 * cabL + 3",
    },
    rules: [
        { check: "=!destinationSign || signH >= 0.1", message: "The letterboard is too shallow for a destination sign: lower the windows or raise the interior." },
    ],
    regions: {
        body: { label: "Body", material: "=bodyFinish" },
        lower: { label: "Lower body", material: "=lowerFinish" },
        roof: { label: "Roof", material: "=roofFinish" },
        accent: { label: "Stripe", material: "=accentFinish" },
        doors: { label: "Doors", material: "=doorFinish" },
        trim: { label: "Frames and trim", material: "=trimFinish" },
        glass: { label: "Glazing", material: "=glassFinish" },
        sign: { label: "Destination sign", material: "=signFinish" },
        headlights: { label: "Headlights", material: "glow.white" },
        tail: { label: "Tail lights", material: "glow.red" },
        lights: { label: "Cabin lights", material: "=lightFinish" },
        floor: { label: "Floor", material: "=floorFinish" },
        seat: { label: "Seats", material: "=seatFinish" },
        seatFrame: { label: "Seat frames", material: "=seatFrameFinish" },
        interior: { label: "Linings and ceiling", material: "=interiorFinish" },
        poles: { label: "Grab poles", material: "=poleFinish" },
        ads: { label: "Advertising cards", material: "paper.label" },
        desk: { label: "Driving desk", material: "plastic.black" },
        screens: { label: "Cab screens", material: "glow.cyan" },
        controller: { label: "Controller", material: "metal.brass" },
        bellows: { label: "Bellows", material: "rubber.black" },
        steps: { label: "Steps", material: "metal.aluminum" },
        bogie: { label: "Bogies", material: "metal.black" },
        wheels: { label: "Wheels", material: "metal.steel" },
        collector: { label: "Collector", material: "metal.black" },
        insulators: { label: "Insulators", material: "ceramic.white" },
        roofGear: { label: "Roof equipment", material: "=roofFinish" },
        rails: { label: "Rails", material: "metal.steel" },
        groove: { label: "Rail grooves", material: "rubber.black" },
        paving: { label: "Paving", material: "stone.cobble" },
        ballast: { label: "Ballast", material: "stone.ballast" },
        sleepers: { label: "Sleepers", material: "wood.sleeper" },
    },
    presets: [
        { name: "City tram", values: {} },
        {
            name: "Heritage streamliner", values: {
                bays: 6, bayWidth: 1.85, width: 2.55, floorHeight: 0.78, interiorHeight: 2.2, skirt: 0.9, roofRadius: 0.42,
                cabLength: 2.0, noseLength: 1.5, bluntness: 0.3, rake: 0.15, windscreen: "three", cabStyle: "classic", mirrors: false,
                sill: 0.72, windowHeight: 0.82, windowShare: 0.72, windowRounding: 0.1, doorPlacement: "ends", doorSides: "one", doorWidth: 1.15, doorStyle: "folding",
                seating: "forward", aisle: 0.6, straps: false, collector: "trolley", roofPods: false, wheelSize: 0.33,
                bodyFinish: "paint.cream", lowerFinish: "paint.brunswick", roofFinish: "paint.brunswick", accentFinish: "metal.chrome", doorFinish: "paint.brunswick", trimFinish: "metal.chrome",
                glassFinish: "glass.windowGreen", seatFinish: "leather.green", seatFrameFinish: "metal.chrome", floorFinish: "wood.oak", interiorFinish: "paint.cream", poleFinish: "metal.chrome", lightFinish: "glow.candle", signFinish: "glow.white",
            },
        },
        {
            name: "Vintage trolley", values: {
                bays: 6, bayWidth: 1.8, width: 2.3, floorHeight: 0.9, interiorHeight: 2.35, skirt: 0, roofRadius: 0.2,
                cabLength: 1.8, noseLength: 0.55, bluntness: 0.85, rake: 0, windscreen: "three", cabStyle: "classic", mirrors: false, bumper: true, lifeguard: true,
                sill: 0.8, windowHeight: 0.85, windowShare: 0.76, windowStyle: "arched", transoms: true, doorPlacement: "ends", doorWidth: 0.95, doorStyle: "folding",
                seating: "facing", aisle: 0.56, collector: "trolley", collectorUp: 0.85, roofPods: false, wheelSize: 0.38,
                bodyFinish: "paint.cream", lowerFinish: "paint.crimson", roofFinish: "paint.black", accentFinish: "metal.gold", doorFinish: "wood.teak", trimFinish: "metal.brass",
                glassFinish: "glass.window", seatFinish: "wood.teak", seatFrameFinish: "metal.black", floorFinish: "wood.oak", interiorFinish: "wood.teak", poleFinish: "metal.brass", lightFinish: "glow.candle", signFinish: "glow.white",
            },
        },
        {
            name: "Articulated light rail", values: {
                sections: 3, bays: 4, bayWidth: 2.15, width: 2.65, floorHeight: 0.35, interiorHeight: 2.3, skirt: 1, roofRadius: 0.36,
                cabLength: 2.7, noseLength: 1.6, bluntness: 0.15, rake: 0.75, windscreen: "panoramic",
                sill: 0.66, windowHeight: 1.22, windowShare: 0.86, windowRounding: 0.06, doors: 1, doorWidth: 1.4,
                seating: "forward", aisle: 0.72, collectorUp: 0.6, track: "ballast",
                bodyFinish: "paint.silver", lowerFinish: "paint.black", roofFinish: "paint.white", accentFinish: "paint.signal", doorFinish: "paint.signal", trimFinish: "plastic.black",
                glassFinish: "glass.windowTinted", seatFinish: "fabric.moquetteRed", poleFinish: "metal.steel", interiorFinish: "plastic.grey", signFinish: "glow.white",
            },
        },
        {
            name: "Metro shuttle", values: {
                sections: 2, bays: 6, bayWidth: 2.0, floorHeight: 0.42, skirt: 0.8, cabLength: 1.9, noseLength: 0.6, bluntness: 0.7, rake: 0.25, windscreen: "split",
                windowStyle: "square", windowShare: 0.84, windowHeight: 1.1, doors: 2, doorWidth: 1.4, doorStyle: "sliding", seating: "longitudinal",
                bodyFinish: "paint.teal", lowerFinish: "paint.teal", roofFinish: "paint.white", accentFinish: "paint.ochre", doorFinish: "paint.ochre", trimFinish: "metal.black",
                glassFinish: "glass.windowBronze", seatFinish: "plastic.grey", interiorFinish: "paint.white", poleFinish: "metal.chrome", lightFinish: "glow.white",
            },
        },
    ],
    nodes: [
        // ================= Track =================
        { id: "pavingSlab", type: "mesh.box", when: "=track == 'street'", size: ["=Lt", "=yR", "=width + 2.2"], at: [0, "=yR / 2", 0], region: "paving" },
        { id: "railProfile", type: "curve.points", output: false, closed: true, points: [[-0.07, 0], [0.07, 0], [0.07, 0.012], [0.009, 0.03], [0.009, 0.11], [0.034, 0.118], [0.034, 0.154], [-0.034, 0.154], [-0.034, 0.118], [-0.009, 0.11], [-0.009, 0.03], [-0.07, 0.012]] },
        { id: "rails", type: "mesh.extrude", when: "=track != 'none'", repeat: 2, outline: "@railProfile", height: "=Lt", rotate: [-90, -90, 0], at: ["=-Lt / 2", "=yR - 0.15", "=index == 0 ? g2 : -g2"], region: "rails" },
        { id: "grooves", type: "mesh.box", when: "=track == 'street'", repeat: 2, size: ["=Lt", 0.006, 0.045], at: [0, "=yR + 0.002", "=(index == 0 ? 1 : -1) * (g2 - 0.06)"], region: "groove" },
        { id: "ballastSection", type: "curve.points", output: false, closed: true, points: [[-1.75, 0], [1.75, 0], [1.35, 0.3], [-1.35, 0.3]] },
        { id: "ballastBed", type: "mesh.extrude", when: "=track == 'ballast'", outline: "@ballastSection", height: "=Lt", rotate: [-90, -90, 0], at: ["=-Lt / 2", 0, 0], region: "ballast" },
        { id: "sleepers", type: "mesh.box", when: "=track == 'ballast'", repeat: "=floor(Lt / 0.62)", size: [0.24, 0.14, 2.5], radius: 0.01, segments: 1, at: ["=-Lt / 2 + 0.31 + index * 0.62 + (Lt - floor(Lt / 0.62) * 0.62) / 2", 0.29, 0], region: "sleepers" },

        // ================= Bogies =================
        // One bogie in its own frame (centred, rails at yR); placed under the bogie bays.
        { id: "wheel", type: "mesh.cylinder", output: false, radius: "=r", height: 0.11, segments: 28, bevel: 0.012, rotate: [90, 0, 0], at: [0, 0, -0.055] },
        { id: "flange", type: "mesh.cylinder", output: false, radius: "=r + 0.025", height: 0.022, segments: 28, rotate: [90, 0, 0], at: [0, 0, -0.077] },
        { id: "hub", type: "mesh.cylinder", output: false, radius: "=r * 0.32", height: 0.14, segments: 16, bevel: 0.01, rotate: [90, 0, 0], at: [0, 0, -0.06] },
        { id: "wheelUnit", type: "geo.join", output: false, meshes: ["@wheel", "@flange", "@hub"] },
        // index: axle (0, 1) x side (+z, -z); the flange faces in.
        { id: "wheelSet", type: "geo.transform", output: false, repeat: 4, mesh: "@wheelUnit", scale: [1, 1, "=index % 2 == 0 ? 1 : -1"], at: ["=(floor(index / 2) - 0.5) * wb", "=yR + r", "=(index % 2 == 0 ? 1 : -1) * g2"], region: "wheels" },
        { id: "sideFrames", type: "mesh.box", output: false, repeat: 2, size: ["=wb + 2 * r * 0.75", 0.15, 0.1], radius: 0.03, segments: 2, at: [0, "=yR + r + 0.02", "=(index == 0 ? 1 : -1) * (g2 + 0.16)"], region: "bogie" },
        { id: "axleBoxes", type: "mesh.box", output: false, repeat: 4, size: [0.26, 0.2, 0.13], radius: 0.02, segments: 1, at: ["=(floor(index / 2) - 0.5) * wb", "=yR + r", "=(index % 2 == 0 ? 1 : -1) * (g2 + 0.17)"], region: "bogie" },
        { id: "springPath", type: "path.helix", output: false, radius: 0.055, pitch: 0.042, turns: 4, segmentsPerTurn: 12 },
        { id: "spring", type: "mesh.sweep", output: false, path: "@springPath", radius: 0.011, sides: 6 },
        { id: "springs", type: "geo.transform", output: false, repeat: 4, mesh: "@spring", at: ["=(floor(index / 2) - 0.5) * wb", "=yR + r + 0.1", "=(index % 2 == 0 ? 1 : -1) * (g2 + 0.17)"], region: "wheels" },
        { id: "axles", type: "mesh.cylinder", output: false, when: "=lowGear", repeat: 2, radius: 0.06, height: "=2 * g2", segments: 12, rotate: [90, 0, 0], at: ["=(index - 0.5) * wb", "=yR + r", "=-g2"], region: "bogie" },
        { id: "transom", type: "mesh.box", output: false, when: "=lowGear", size: [0.32, 0.14, "=2 * g2 + 0.3"], radius: 0.02, segments: 1, at: [0, "=yR + r + 0.01", 0], region: "bogie" },
        { id: "motor", type: "mesh.box", output: false, when: "=lowGear", size: ["=wb * 0.5", 0.24, 0.7], radius: 0.05, segments: 2, at: ["=wb * 0.25", "=yR + r - 0.04", 0], region: "bogie" },
        { id: "bogieUnit", type: "geo.join", output: false, meshes: ["@wheelSet", "@sideFrames", "@axleBoxes", "@springs", "@axles", "@transom", "@motor"] },
        // index: section x (near, far bogie bay).
        { id: "bogies", type: "geo.transform", repeat: "=2 * S", mesh: "@bogieUnit", at: ["=-xE + floor(index / 2) * (secLen + gapJ) + ((index % 2 == 0 ? bj0 : bays - 1 - bj0) + 0.5) * cw", 0, 0] },
        // Equipment cases under a high floor, between the bogies.
        { id: "underCases", type: "mesh.box", when: "=lowGear && secLen - 2 * (bj0 + 1) * cw - 0.4 >= 0.6", repeat: "=2 * S", size: ["=secLen - 2 * (bj0 + 1) * cw - 0.4", "=min(0.4, yF - 0.14 - yR - 0.2)", 0.55], radius: 0.03, segments: 1, at: ["=-xE + floor(index / 2) * (secLen + gapJ) + secLen / 2", "=yF - 0.12 - min(0.4, yF - 0.14 - yR - 0.2) / 2", "=(index % 2 == 0 ? 1 : -1) * 0.62"], region: "bogie" },

        // ================= Side walls =================
        // Two panels per (cell, side): below the belt (the lower livery) and above it, each with a
        // window or the doorway cut out.
        { id: "lowerSolid", type: "curve.points", output: false, closed: true, points: [["=-cw / 2", 0], ["=cw / 2", 0], ["=cw / 2", "=hL"], ["=-cw / 2", "=hL"]] },
        { id: "lowerDoor", type: "curve.points", output: false, closed: true, points: [["=-cw / 2", 0], ["=cw / 2", 0], ["=cw / 2", "=hL"], ["=dw / 2", "=hL"], ["=dw / 2", "=vF"], ["=-dw / 2", "=vF"], ["=-dw / 2", "=hL"], ["=-cw / 2", "=hL"]] },
        { id: "upperSolid", type: "curve.points", output: false, closed: true, points: [["=-cw / 2", 0], ["=cw / 2", 0], ["=cw / 2", "=hU"], ["=-cw / 2", "=hU"]] },
        { id: "upperDoor", type: "curve.points", output: false, closed: true, points: [["=-cw / 2", 0], ["=-dw / 2", 0], ["=-dw / 2", "=dTop"], ["=dw / 2", "=dTop"], ["=dw / 2", 0], ["=cw / 2", 0], ["=cw / 2", "=hU"], ["=-cw / 2", "=hU"]] },
        // Window openings with their bottom at v = 0 (shifted up 0.05 where they're cut).
        { id: "winRect", type: "curve.rect", output: false, width: "=ww", height: "=wh", radius: "=wr", cornerSegments: 5 },
        { id: "winRectBase", type: "curve.transform", output: false, curve: "@winRect", offset: [0, "=wh / 2"] },
        { id: "winArch", type: "curve.arch", output: false, width: "=ww", height: "=wh", rise: "=archRise", segments: 14 },
        { id: "winBase", type: "curve.transform", output: false, curve: { if: "=windowStyle == 'arched'", then: "@winArch", else: "@winRectBase" } },
        { id: "winHole", type: "curve.transform", output: false, curve: "@winBase", offset: [0, 0.05] },
        { id: "winFrameOuter", type: "curve.transform", output: false, curve: "@winBase", scale: ["=(ww + 0.09) / ww", "=(wh + 0.08) / wh"], offset: [0, 0.01] },
        { id: "transomRect", type: "curve.rect", output: false, width: "=ww", height: "=max(0.05, tH)", radius: "=min(wr, 0.05)", cornerSegments: 4 },
        { id: "transomHole", type: "curve.transform", output: false, curve: "@transomRect", offset: [0, "=0.05 + wh + 0.09 + tH / 2"] },
        { id: "transomFrameOuter", type: "curve.rect", output: false, width: "=ww + 0.08", height: "=max(0.05, tH) + 0.08", radius: "=min(wr, 0.05) + 0.04", cornerSegments: 4 },
        { id: "transomFrameAt", type: "curve.transform", output: false, curve: "@transomFrameOuter", offset: [0, "=0.05 + wh + 0.09 + tH / 2"] },
        {
            id: "lowerWalls", type: "mesh.extrude", repeat: "=2 * S * bays", outline: { if: `=${isDoor(C2.i, C2.k)}`, then: "@lowerDoor", else: "@lowerSolid" },
            height: "=th", rotate: [-90, `=${C2.k} == 0 ? 0 : 180`, 0], at: [`=${cellX(C2.i)}`, "=ySk", `=${C2.s} * hw`], region: "lower",
        },
        {
            id: "upperWalls", type: "mesh.extrude", repeat: "=2 * S * bays", outline: { if: `=${isDoor(C2.i, C2.k)}`, then: "@upperDoor", else: "@upperSolid" },
            holes: { if: `=${isDoor(C2.i, C2.k)}`, then: [], else: { if: "=tOK", then: ["@winHole", "@transomHole"], else: ["@winHole"] } },
            height: "=th", rotate: [-90, `=${C2.k} == 0 ? 0 : 180`, 0], at: [`=${cellX(C2.i)}`, "=yBelt", `=${C2.s} * hw`], region: "body",
        },
        // Glazing and rubber or metal frames for every window (and transom).
        { id: "winGlass", type: "mesh.extrude", output: false, outline: "@winHole", height: 0.02, rotate: [-90, 0, 0], at: [0, 0, "=-th / 2 + 0.01"], region: "glass" },
        { id: "winFrame", type: "mesh.extrude", output: false, outline: "@winFrameOuter", holes: ["@winHole"], height: "=th + 0.03", bevel: 0.01, rotate: [-90, 0, 0], at: [0, 0, 0.015], region: "trim" },
        { id: "transomGlass", type: "mesh.extrude", output: false, when: "=tOK", outline: "@transomHole", height: 0.02, rotate: [-90, 0, 0], at: [0, 0, "=-th / 2 + 0.01"], region: "glass" },
        { id: "transomFrame", type: "mesh.extrude", output: false, when: "=tOK", outline: "@transomFrameAt", holes: ["@transomHole"], height: "=th + 0.03", bevel: 0.01, rotate: [-90, 0, 0], at: [0, 0, 0.015], region: "trim" },
        { id: "windowUnit", type: "geo.join", output: false, meshes: ["@winGlass", "@winFrame", "@transomGlass", "@transomFrame"] },
        {
            id: "windows", type: "geo.transform", repeat: "=2 * S * bays", keep: `=!${isDoor(C2.i, C2.k)}`, mesh: "@windowUnit",
            rotate: [0, `=${C2.k} == 0 ? 0 : 180`, 0], at: [`=${cellX(C2.i)}`, "=yBelt", `=${C2.s} * hw`],
        },
        // The livery stripe under the windows, and on the doors' leaves it is left off.
        {
            id: "stripes", type: "mesh.box", when: "=stripe", repeat: "=2 * S * bays", keep: `=!${isDoor(C2.i, C2.k)}`, size: ["=cw + 0.002", 0.1, 0.012],
            at: [`=${cellX(C2.i)}`, "=yBelt - 0.12", `=${C2.s} * (hw + 0.006)`], region: "accent",
        },

        // Rain gutters along the eaves.
        { id: "gutters", type: "mesh.box", when: "=roofShown", repeat: "=2 * S", size: ["=secLen", 0.035, 0.03], radius: 0.01, segments: 1, at: ["=-xE + floor(index / 2) * (secLen + gapJ) + secLen / 2", "=yE + 0.01", "=(index % 2 == 0 ? 1 : -1) * (hw + 0.012)"], region: "trim" },

        // ================= Doors =================
        // A leaf hinged at its outer edge (the origin), glazed above the waist, reaching toward +X.
        { id: "leafOutline", type: "curve.points", output: false, closed: true, points: [[0.004, 0], ["=lw", 0], ["=lw", "=dh - 0.01"], [0.004, "=dh - 0.01"]] },
        { id: "leafGlassHole", type: "curve.rect", output: false, width: "=lw - 0.16", height: "=dh * 0.6", radius: 0.05, cornerSegments: 4 },
        { id: "leafGlassAt", type: "curve.transform", output: false, curve: "@leafGlassHole", offset: ["=lw / 2", "=dh * 0.6"] },
        { id: "leafPanel", type: "mesh.extrude", output: false, outline: "@leafOutline", holes: ["@leafGlassAt"], height: 0.04, bevel: 0.008, rotate: [-90, 0, 0], at: [0, 0, 0.02], region: "doors" },
        { id: "leafGlass", type: "mesh.extrude", output: false, outline: "@leafGlassAt", height: 0.012, rotate: [-90, 0, 0], at: [0, 0, 0.006], region: "glass" },
        { id: "leafPush", type: "mesh.box", output: false, size: [0.04, 0.035, 0.07], radius: 0.012, segments: 2, at: ["=lw - 0.12", "=dh * 0.48", 0], region: "tail" },
        { id: "leaf", type: "geo.join", output: false, meshes: ["@leafPanel", "@leafGlass", "@leafPush"] },
        {
            // index = 4 cell + 2 side + leaf: plug leaves pop out and slide apart, sliding ones run
            // inside the wall, folding ones swing in about the jambs.
            id: "doorLeaves", type: "geo.transform", repeat: "=4 * S * bays", keep: `=${isDoor(C4.i, C4.k)}`, mesh: "@leaf",
            scale: [`=${C4.m} == 0 ? 1 : -1`, 1, 1],
            rotate: [0, `=doorStyle == 'folding' ? ${C4.s} * (${C4.m} == 0 ? 1 : -1) * 84 * doorOpen : 0`, 0],
            at: [
                `=${cellX(C4.i)} + (${C4.m} == 0 ? -1 : 1) * (dw / 2 + (doorStyle == 'folding' ? 0 : doorOpen * (lw - 0.04)))`, "=yF",
                `=${C4.s} * (doorStyle == 'plug' ? hw - 0.02 + 0.08 * doorOpen : doorStyle == 'sliding' ? hwi - 0.03 : hw - th / 2)`,
            ],
        },
        // Door surrounds (trim) and, on high floors, boarding steps hung below the threshold.
        { id: "doorSurroundOuter", type: "curve.points", output: false, closed: true, points: [["=-dw / 2 - 0.05", 0], ["=dw / 2 + 0.05", 0], ["=dw / 2 + 0.05", "=dh + 0.05"], ["=-dw / 2 - 0.05", "=dh + 0.05"]] },
        { id: "doorSurroundInner", type: "curve.points", output: false, closed: true, points: [["=-dw / 2", -0.01], ["=dw / 2", -0.01], ["=dw / 2", "=dh"], ["=-dw / 2", "=dh"]] },
        { id: "doorSurroundShape", type: "curve.points", output: false, closed: true, points: [["=-dw / 2 - 0.05", 0], ["=-dw / 2", 0], ["=-dw / 2", "=dh"], ["=dw / 2", "=dh"], ["=dw / 2", 0], ["=dw / 2 + 0.05", 0], ["=dw / 2 + 0.05", "=dh + 0.05"], ["=-dw / 2 - 0.05", "=dh + 0.05"]] },
        {
            id: "doorSurrounds", type: "mesh.extrude", repeat: "=2 * S * bays", keep: `=${isDoor(C2.i, C2.k)}`, outline: "@doorSurroundShape", height: "=th + 0.03", bevel: 0.008,
            rotate: [-90, `=${C2.k} == 0 ? 0 : 180`, 0], at: [`=${cellX(C2.i)}`, "=yF", `=${C2.s} * (hw + 0.015)`], region: "trim",
        },
        { id: "thresholds", type: "mesh.box", repeat: "=2 * S * bays", keep: `=${isDoor(C2.i, C2.k)}`, size: ["=dw", 0.025, "=th + 0.04"], at: [`=${cellX(C2.i)}`, "=yF - 0.0125", `=${C2.s} * (hw - th / 2 + 0.02)`], region: "steps" },
        {
            // index = (cell, side) x step.
            id: "doorSteps", type: "mesh.box", when: "=nSteps > 0", repeat: "=2 * S * bays * max(1, nSteps)", keep: `=${isDoor("floor(index / max(1, nSteps) / 2)", "(floor(index / max(1, nSteps)) % 2)")}`,
            size: ["=dw - 0.06", 0.04, 0.26],
            at: [`=${cellX("floor(index / max(1, nSteps) / 2)")}`, "=yF - (index % max(1, nSteps) + 1) * stepRise", "=(floor(index / max(1, nSteps)) % 2 == 0 ? 1 : -1) * (hw + 0.13 + (index % max(1, nSteps)) * 0.24)"], region: "steps",
        },
        {
            id: "stepHangers", type: "mesh.box", when: "=nSteps > 0", repeat: "=4 * S * bays", keep: `=${isDoor(C4.i, C4.k)}`,
            size: [0.03, "=nSteps * stepRise + 0.02", 0.03], at: [`=${cellX(C4.i)} + (${C4.m} == 0 ? -1 : 1) * (dw / 2 - 0.05)`, "=yF - (nSteps * stepRise + 0.02) / 2", `=${C4.s} * (hw + 0.03 + nSteps * 0.12)`], region: "steps",
        },

        // ================= Floor, linings, ceiling =================
        { id: "floorSlab", type: "mesh.box", size: ["=Ltot + 0.01", 0.12, "=2 * hwi + 0.004"], at: [0, "=yF - 0.06", 0], region: "floor" },
        {
            id: "podiums", type: "mesh.box", when: "=podH > 0", repeat: "=2 * S * bays", keep: `=!${isDoor(C2.i, C2.k)} && ${isBogie(C2.i)}`,
            size: ["=cw - 0.02", "=podH", "=hwi - zPod0"], radius: 0.02, segments: 1, at: [`=${cellX(C2.i)}`, "=yF + podH / 2", `=${C2.s} * (zPod0 + (hwi - zPod0) / 2)`], region: "interior",
        },
        {
            id: "linings", type: "mesh.box", repeat: "=2 * S * bays", keep: `=!${isDoor(C2.i, C2.k)}`, size: ["=cw - 0.03", "=sill - 0.02", 0.025],
            at: [`=${cellX(C2.i)}`, "=yF + sill / 2", `=${C2.s} * (hwi - 0.0125)`], region: "interior",
        },
        {
            id: "sills", type: "mesh.box", repeat: "=2 * S * bays", keep: `=!${isDoor(C2.i, C2.k)}`, size: ["=cw - 0.03", 0.03, 0.09], radius: 0.01, segments: 1,
            at: [`=${cellX(C2.i)}`, "=yBelt + 0.035", `=${C2.s} * (hwi - 0.045)`], region: "interior",
        },
        // Coves between the window heads and the ceiling, with advertising cards in them.
        {
            id: "coves", type: "mesh.box", when: "=roofShown", repeat: "=2 * S", size: ["=secLen - 0.02", 0.36, 0.02],
            rotate: ["=(index % 2 == 0 ? -1 : 1) * 50", 0, 0], at: ["=-xE + floor(index / 2) * (secLen + gapJ) + secLen / 2", "=yE - 0.14", "=(index % 2 == 0 ? 1 : -1) * (hwi - 0.12)"], region: "interior",
        },
        {
            id: "adCardsInCoves", type: "mesh.box", when: "=roofShown && adCards", repeat: "=2 * S * bays", keep: `=!${isDoor(C2.i, C2.k)}`, size: ["=min(0.9, cw - 0.5)", 0.26, 0.006],
            rotate: [`=${C2.s} * -50`, 0, 0], at: [`=${cellX(C2.i)}`, "=yE - 0.14 - 0.008", `=${C2.s} * (hwi - 0.12 - 0.012)`], region: "ads",
        },
        { id: "ceiling", type: "mesh.box", when: "=roofShown", size: ["=Ltot + 0.01", 0.03, "=2 * hwi + 0.004"], at: [0, "=yE - 0.015", 0], region: "interior" },
        { id: "ceilingLights", type: "mesh.box", when: "=roofShown", repeat: "=2 * S", size: ["=secLen - 0.6", 0.025, 0.12], radius: 0.008, segments: 1, at: ["=-xE + floor(index / 2) * (secLen + gapJ) + secLen / 2", "=yE - 0.04", "=(index % 2 == 0 ? 1 : -1) * min(hwi - 0.45, (lon ? 0.3 : aisle / 2 + 0.22))"], region: "lights" },

        // ================= Seats =================
        // A transverse seat facing +X, centred across its width sw, its aisle leg toward +Z.
        { id: "cushions", type: "mesh.box", output: false, repeat: "=nCush", size: [0.46, 0.1, "=(sw - 0.04) / nCush - 0.03"], radius: 0.035, segments: 2, at: [0.01, "=seatY - 0.05", "=(index - (nCush - 1) / 2) * (sw - 0.04) / nCush"], region: "seat" },
        { id: "backs", type: "mesh.box", output: false, repeat: "=nCush", size: [0.09, 0.56, "=(sw - 0.04) / nCush - 0.03"], radius: 0.035, segments: 2, rotate: [0, 0, 9], at: [-0.215, "=seatY + 0.3", "=(index - (nCush - 1) / 2) * (sw - 0.04) / nCush"], region: "seat" },
        { id: "seatPan", type: "mesh.box", output: false, size: [0.44, 0.04, "=sw - 0.04"], radius: 0.01, segments: 1, at: [0.01, "=seatY - 0.12", 0], region: "seatFrame" },
        { id: "seatShell", type: "mesh.box", output: false, size: [0.03, 0.58, "=sw - 0.04"], radius: 0.012, segments: 1, rotate: [0, 0, 9], at: [-0.27, "=seatY + 0.28", 0], region: "seatFrame" },
        { id: "seatLeg", type: "mesh.box", output: false, size: [0.06, "=seatY - 0.14", 0.06], at: [0, "=(seatY - 0.14) / 2", "=-(sw / 2 - 0.08)"], region: "seatFrame" },
        { id: "seatFoot", type: "mesh.box", output: false, size: [0.4, 0.025, 0.07], radius: 0.01, segments: 1, at: [0, 0.0125, "=-(sw / 2 - 0.08)"], region: "seatFrame" },
        { id: "grabPath", type: "path.points", output: false, fillet: 0.05, filletSegments: 4, points: [[-0.25, "=seatY + 0.5", "=-(sw / 2 - 0.2)"], [-0.29, "=seatY + 0.68", "=-(sw / 2 - 0.2)"], [-0.29, "=seatY + 0.68", "=-(sw / 2 - 0.05)"], [-0.25, "=seatY + 0.5", "=-(sw / 2 - 0.05)"]] },
        { id: "grab", type: "mesh.sweep", output: false, path: "@grabPath", radius: 0.016, sides: 8, region: "poles" },
        { id: "seatUnit", type: "geo.join", output: false, meshes: ["@cushions", "@backs", "@seatPan", "@seatShell", "@seatLeg", "@seatFoot", "@grab"] },
        {
            // index = 4 cell + 2 side + row: two rows per window bay, face to face or both forward.
            id: "seats", type: "geo.transform", when: "=!lon", repeat: "=4 * S * bays", keep: `=!${isDoor(C4.i, C4.k)}`, mesh: "@seatUnit",
            scale: [`=seating == 'facing' && ${C4.m} == 1 ? -1 : 1`, 1, `=${C4.s}`],
            at: [`=${cellX(C4.i)} + (${C4.m} == 0 ? -1 : 1) * (seating == 'facing' ? cw / 2 - 0.33 : cw / 4) + (seating == 'facing' ? 0 : 0.06)`, `=yF + (${isBogie(C4.i)} ? podH : 0)`, `=${C4.s} * zSeat`],
        },
        // Benches along the sides, facing the aisle.
        { id: "benchCushion", type: "mesh.box", output: false, size: ["=cw - 0.26", 0.1, 0.44], radius: 0.035, segments: 2, at: [0, "=seatY - 0.05", -0.24], region: "seat" },
        { id: "benchBack", type: "mesh.box", output: false, size: ["=cw - 0.26", 0.5, 0.08], radius: 0.035, segments: 2, rotate: [8, 0, 0], at: [0, "=seatY + 0.28", -0.035], region: "seat" },
        { id: "benchPlinth", type: "mesh.box", output: false, size: ["=cw - 0.3", "=seatY - 0.1", 0.36], radius: 0.01, segments: 1, at: [0, "=(seatY - 0.1) / 2", -0.22], region: "seatFrame" },
        { id: "benchUnit", type: "geo.join", output: false, meshes: ["@benchCushion", "@benchBack", "@benchPlinth"] },
        {
            id: "benches", type: "geo.transform", when: "=lon", repeat: "=2 * S * bays", keep: `=!${isDoor(C2.i, C2.k)}`, mesh: "@benchUnit",
            scale: [1, 1, `=${C2.s}`], at: [`=${cellX(C2.i)}`, `=yF + (${isBogie(C2.i)} ? podH : 0)`, `=${C2.s} * (hwi - 0.01)`],
        },

        // ================= Grab poles, rails and straps =================
        {
            // index = 2 boundary + side, every bay boundary of every section.
            id: "stanchions", type: "mesh.cylinder", repeat: "=2 * S * (bays + 1)", radius: 0.017, height: "=interiorHeight", segments: 10,
            at: ["=-xE + floor(floor(index / 2) / (bays + 1)) * (secLen + gapJ) + (floor(index / 2) % (bays + 1)) * cw", "=yF", "=(index % 2 == 0 ? 1 : -1) * zPole"], region: "poles",
        },
        { id: "doorPoles", type: "mesh.cylinder", repeat: "=S * bays", keep: `=${isDoor("index", "0")} && dw >= 1.2 && doorStyle != 'folding'`, radius: 0.019, height: "=interiorHeight", segments: 10, at: [`=${cellX("index")}`, "=yF", 0], region: "poles" },
        { id: "ceilingRails", type: "mesh.cylinder", repeat: "=2 * S", radius: 0.016, height: "=secLen - 0.1", segments: 10, rotate: [0, 0, -90], at: ["=-xE + floor(index / 2) * (secLen + gapJ) + 0.05", "=min(yF + 1.9, yE - 0.12)", "=(index % 2 == 0 ? 1 : -1) * zPole"], region: "poles" },
        { id: "strapBand", type: "mesh.box", output: false, size: [0.03, 0.2, 0.012], at: [0, -0.1, 0], region: "interior" },
        { id: "strapRing", type: "mesh.torus", output: false, major: 0.065, minor: 0.013, segments: 14, sides: 6, rotate: [90, 0, 0], at: [0, -0.26, 0], region: "poles" },
        { id: "strapUnit", type: "geo.join", output: false, meshes: ["@strapBand", "@strapRing"] },
        {
            id: "strapsPlaced", type: "geo.transform", when: "=straps", repeat: "=2 * S * floor((secLen - 0.6) / 0.5)", mesh: "@strapUnit",
            at: ["=-xE + floor(floor(index / 2) / floor((secLen - 0.6) / 0.5)) * (secLen + gapJ) + 0.55 + (floor(index / 2) % floor((secLen - 0.6) / 0.5)) * 0.5", "=min(yF + 1.9, yE - 0.12) - 0.01", "=(index % 2 == 0 ? 1 : -1) * zPole"],
        },

        // ================= Roof =================
        {
            // index = section x slice.
            id: "roofSlices", type: "mesh.loft", output: false, when: "=roofShown", repeat: `=S * ${ROOF_K}`,
            bottom: rect("-xE + floor(index / 5) * (secLen + gapJ)", "-xE + floor(index / 5) * (secLen + gapJ) + secLen", `hw - ${roofD("index % 5")}`),
            top: rect("-xE + floor(index / 5) * (secLen + gapJ)", "-xE + floor(index / 5) * (secLen + gapJ) + secLen", `hw - ${roofD("index % 5 + 1")}`),
            height: `=${roofH("index % 5 + 1")} - ${roofH("index % 5")}`, at: [0, `=yE + ${roofH("index % 5")}`, 0],
        },
        { id: "roofShell", type: "geo.smooth", when: "=roofShown", mesh: "@roofSlices", angle: 40, region: "roof" },
        {
            id: "roofPodsPlaced", type: "mesh.box", when: "=roofShown && roofPods", repeat: "=S", size: ["=min(secLen * 0.34, 2.6)", 0.34, "=width * 0.56"], radius: 0.1, segments: 3,
            at: ["=-xE + index * (secLen + gapJ) + secLen / 2 - (collector != 'none' && index == kP ? min(secLen * 0.3, 2.4) : 0)", "=yTop + 0.16", 0], region: "roofGear",
        },
        { id: "roofWalk", type: "mesh.box", when: "=roofShown && collector != 'none'", size: [2.2, 0.03, 0.5], at: ["=xP + 0.2", "=yTop + 0.015", "=-0.45"], region: "trim" },

        // ================= Pantograph =================
        // A single-arm pantograph on insulators: lower arm from the base hinge back to the knee,
        // upper arm forward to the head over the hinge, which `collectorUp` raises toward the wire.
        { id: "panBase", type: "mesh.box", when: "=roofShown && collector == 'pantograph'", size: [1.5, 0.1, 1.1], radius: 0.02, segments: 1, at: ["=xP", "=yTop + 0.2", 0], region: "collector" },
        { id: "panInsulators", type: "mesh.cylinder", when: "=roofShown && collector == 'pantograph'", repeat: 4, radius: 0.06, height: 0.16, segments: 12, bevel: 0.02, at: ["=xP + (index < 2 ? -0.6 : 0.6)", "=yTop - 0.01", "=(index % 2 == 0 ? 1 : -1) * 0.42"], region: "insulators" },
        { id: "panLowerPath", type: "path.points", output: false, points: [["=xP + 0.45", "=yTop + 0.3", 0], ["=xP + 0.45 + panKx", "=yTop + 0.3 + panH / 2", 0]] },
        { id: "panLower", type: "mesh.sweep", output: false, path: "@panLowerPath", radius: 0.045, sides: 10, taper: 0.7 },
        { id: "panLowerPair", type: "geo.transform", when: "=roofShown && collector == 'pantograph'", repeat: 2, mesh: "@panLower", at: [0, 0, "=(index == 0 ? 1 : -1) * 0.22"], region: "collector" },
        { id: "panUpperPath", type: "path.points", output: false, points: [["=xP + 0.45 + panKx", "=yTop + 0.3 + panH / 2", 0], ["=xP + 0.45", "=yTop + 0.3 + panH", 0]] },
        { id: "panUpper", type: "mesh.sweep", when: "=roofShown && collector == 'pantograph'", path: "@panUpperPath", radius: 0.032, sides: 10, region: "collector" },
        { id: "panKnee", type: "mesh.cylinder", when: "=roofShown && collector == 'pantograph'", radius: 0.06, height: 0.56, segments: 12, rotate: [90, 0, 0], at: ["=xP + 0.45 + panKx", "=yTop + 0.3 + panH / 2", -0.28], region: "collector" },
        { id: "panHinge", type: "mesh.cylinder", when: "=roofShown && collector == 'pantograph'", radius: 0.07, height: 0.6, segments: 12, rotate: [90, 0, 0], at: ["=xP + 0.45", "=yTop + 0.3", -0.3], region: "collector" },
        { id: "panHeadPath", type: "path.points", output: false, fillet: 0.12, filletSegments: 5, points: [["=xP + 0.45", "=yTop + 0.3 + panH - 0.12", -1.0], ["=xP + 0.45", "=yTop + 0.3 + panH + 0.04", -0.72], ["=xP + 0.45", "=yTop + 0.3 + panH + 0.04", 0.72], ["=xP + 0.45", "=yTop + 0.3 + panH - 0.12", 1.0]] },
        { id: "panHeadBow", type: "mesh.sweep", output: false, path: "@panHeadPath", radius: 0.025, sides: 8 },
        { id: "panHead", type: "geo.transform", when: "=roofShown && collector == 'pantograph'", repeat: 2, mesh: "@panHeadBow", at: ["=(index == 0 ? -1 : 1) * 0.11", 0, 0], region: "collector" },
        { id: "panStrips", type: "mesh.box", when: "=roofShown && collector == 'pantograph'", size: [0.3, 0.04, 1.44], radius: 0.01, segments: 1, at: ["=xP + 0.45", "=yTop + 0.3 + panH + 0.06", 0], region: "wheels" },

        // ================= Trolley poles =================
        // Two spring-loaded poles: one raised toward the wire, trailing back, one hooked down.
        { id: "trolleyBases", type: "mesh.box", when: "=roofShown && collector == 'trolley'", repeat: 2, size: [0.7, 0.22, 0.42], radius: 0.05, segments: 2, at: ["=(index == 0 ? 1 : -1) * 0.7", "=yTop + 0.11", 0], region: "collector" },
        { id: "trolleyPivots", type: "mesh.cylinder", when: "=roofShown && collector == 'trolley'", repeat: 2, radius: 0.09, height: 0.36, segments: 14, rotate: [90, 0, 0], at: ["=(index == 0 ? 1 : -1) * 0.7", "=yTop + 0.28", -0.18], region: "collector" },
        { id: "trolleyPathA", type: "path.points", output: false, points: [[0.7, "=yTop + 0.28", 0], ["=0.7 - poleLen * cos(rad(poleA))", "=yTop + 0.28 + poleLen * sin(rad(poleA))", 0]] },
        { id: "trolleyPathB", type: "path.points", output: false, points: [[-0.7, "=yTop + 0.28", 0], ["=-0.7 + poleLen * cos(rad(3))", "=yTop + 0.28 + poleLen * sin(rad(3))", 0]] },
        { id: "trolleyPoleA", type: "mesh.sweep", when: "=roofShown && collector == 'trolley'", path: "@trolleyPathA", radius: 0.034, sides: 10, taper: 0.55, region: "collector" },
        { id: "trolleyPoleB", type: "mesh.sweep", when: "=roofShown && collector == 'trolley'", path: "@trolleyPathB", radius: 0.034, sides: 10, taper: 0.55, region: "collector" },
        // index 0: the raised pole's shoe, trailing toward -X; 1: the lowered one's, under its hook.
        {
            id: "trolleyShoes", type: "mesh.cylinder", when: "=roofShown && collector == 'trolley'", repeat: 2, radius: 0.065, height: 0.05, segments: 16, rotate: [90, 0, 0],
            at: ["=index == 0 ? 0.7 - (poleLen + 0.05) * cos(rad(poleA)) : -0.7 + (poleLen + 0.05) * cos(rad(3))", "=yTop + 0.28 + (index == 0 ? (poleLen + 0.05) * sin(rad(poleA)) : (poleLen + 0.05) * sin(rad(3))) + 0.06", -0.025], region: "wheels",
        },
        { id: "trolleyHooks", type: "mesh.box", when: "=roofShown && collector == 'trolley'", repeat: 2, size: [0.06, 0.32, 0.18], at: ["=(index == 0 ? 1 : -1) * (poleLen * cos(rad(3)) - 1.4)", "=yTop + 0.16", 0], region: "collector" },

        // ================= Bellows between sections =================
        // Folds alternate between the body's outline and a little inside it.
        { id: "bellowsOuter", type: "curve.rect", output: false, width: "=width - 0.04", height: "=yTop - 0.04 - ySk", radius: "=Rr", cornerSegments: 6 },
        { id: "bellowsFold", type: "curve.rect", output: false, width: "=width - 0.12", height: "=yTop - 0.12 - ySk", radius: "=max(0.04, Rr - 0.04)", cornerSegments: 6 },
        { id: "bellowsInner", type: "curve.rect", output: false, width: "=width - 0.22", height: "=yTop - 0.22 - ySk", radius: "=max(0.04, Rr - 0.09)", cornerSegments: 6 },
        { id: "bellowsOuterAt", type: "curve.transform", output: false, curve: "@bellowsOuter", offset: [0, "=(yTop - 0.04 + ySk) / 2"] },
        { id: "bellowsFoldAt", type: "curve.transform", output: false, curve: "@bellowsFold", offset: [0, "=(yTop - 0.04 + ySk) / 2"] },
        { id: "bellowsInnerAt", type: "curve.transform", output: false, curve: "@bellowsInner", offset: [0, "=(yTop - 0.04 + ySk) / 2"] },
        {
            id: "bellowsRings", type: "mesh.extrude", when: "=S > 1", repeat: "=9 * (S - 1)", outline: { if: "=index % 2 == 0", then: "@bellowsOuterAt", else: "@bellowsFoldAt" }, holes: ["@bellowsInnerAt"], height: "=gapJ / 9", bevel: 0.015,
            rotate: [-90, -90, 0], at: ["=-xE + (floor(index / 9) + 1) * secLen + floor(index / 9) * gapJ + (index % 9) * gapJ / 9", 0, 0], region: "bellows",
        },

        // ================= Cabs (nose-local, placed at both ends) =================
        { id: "dashShape", type: "curve.points", output: false, closed: true, points: noseShell("0", "th") },
        { id: "dash", type: "mesh.extrude", output: false, outline: "@dashShape", height: "=hL", smoothAngle: 40, at: [0, "=ySk", 0], region: "lower" },
        { id: "screenBandRaw", type: "mesh.loft", output: false, bottom: noseShell("0", "th"), top: noseShell("0", "th", "rake"), height: "=yCT - yBelt", at: [0, "=yBelt", 0] },
        { id: "screenBand", type: "geo.smooth", output: false, mesh: "@screenBandRaw", angle: 40, region: "glass" },
        { id: "letterShape", type: "curve.points", output: false, closed: true, points: noseShell("0", "th", "rake") },
        { id: "letterboard", type: "mesh.extrude", output: false, outline: "@letterShape", height: "=lbH", smoothAngle: 40, at: [0, "=yCT", 0], region: "body" },
        { id: "noseStripeShape", type: "curve.points", output: false, closed: true, points: noseShell("-0.006", "0.02") },
        { id: "noseStripe", type: "mesh.extrude", output: false, when: "=stripe", outline: "@noseStripeShape", height: 0.1, smoothAngle: 40, at: [0, "=yBelt - 0.17", 0], region: "accent" },
        { id: "bumperShape", type: "curve.points", output: false, closed: true, points: noseShell("-0.05", "0.02") },
        { id: "bumperBand", type: "mesh.extrude", output: false, when: "=bumper", outline: "@bumperShape", height: 0.12, bevel: 0.01, smoothAngle: 40, at: [0, "=ySk + 0.05", 0], region: "trim" },
        {
            id: "noseRoofSlices", type: "mesh.loft", output: false, when: "=roofShown", repeat: ROOF_K,
            bottom: nosePlan(roofD("index"), "rake"), top: nosePlan(roofD("index + 1"), "rake"),
            height: `=${roofH("index + 1")} - ${roofH("index")}`, at: [0, `=yE + ${roofH("index")}`, 0],
        },
        { id: "noseRoof", type: "geo.smooth", output: false, when: "=roofShown", mesh: "@noseRoofSlices", angle: 40, region: "roof" },
        // Pillars: at the partition, where the nose starts to curve, and the windscreen's own.
        { id: "pillarBPath", type: "path.points", output: false, points: [[0.045, "=yBelt", "=hw - th / 2"], [0.045, "=yCT", "=hw - th / 2"]] },
        { id: "pillarB", type: "mesh.sweep", output: false, path: "@pillarBPath", radius: 0.045, sides: 8 },
        { id: "pillarsB", type: "geo.transform", output: false, repeat: 2, mesh: "@pillarB", scale: [1, 1, "=index == 0 ? 1 : -1"], region: "body" },
        { id: "pillarAPath", type: "path.points", output: false, points: [[`=${frame("th / 2", "0").xs}`, "=yBelt", "=hw - th / 2"], [`=${frame("th / 2", "rake").xs}`, "=yCT", "=hw - th / 2"]] },
        { id: "pillarA", type: "mesh.sweep", output: false, path: "@pillarAPath", radius: 0.05, sides: 8 },
        { id: "pillarsA", type: "geo.transform", output: false, when: "=cabL - nL > 0.3", repeat: 2, mesh: "@pillarA", scale: [1, 1, "=index == 0 ? 1 : -1"], region: "body" },
        { id: "pillarCPath", type: "path.points", output: false, points: [[`=${noseX("0", "th / 2")}`, "=yBelt", 0], [`=${noseX("0", "th / 2", "rake")}`, "=yCT", 0]] },
        { id: "pillarC", type: "mesh.sweep", output: false, when: "=windscreen == 'split'", path: "@pillarCPath", radius: 0.04, sides: 8, region: "body" },
        { id: "pillar3Path", type: "path.points", output: false, points: [[`=${noseX("hw * 0.42", "th / 2")}`, "=yBelt", "=hw * 0.42"], [`=${noseX("hw * 0.42", "th / 2", "rake")}`, "=yCT", "=hw * 0.42"]] },
        { id: "pillar3", type: "mesh.sweep", output: false, path: "@pillar3Path", radius: 0.04, sides: 8 },
        { id: "pillars3", type: "geo.transform", output: false, when: "=windscreen == 'three'", repeat: 2, mesh: "@pillar3", scale: [1, 1, "=index == 0 ? 1 : -1"], region: "body" },
        // Lamps on the dash, the destination sign on the letterboard, mirrors on arms.
        { id: "headlamps", type: "mesh.sphere", output: false, repeat: 2, radius: 0.085, segments: 16, rings: 8, at: [`=${noseX("hw * 0.56")} - 0.02`, "=yLamp", "=(index == 0 ? 1 : -1) * hw * 0.56"], region: "headlights" },
        { id: "headlampRims", type: "mesh.torus", output: false, repeat: 2, major: 0.09, minor: 0.014, segments: 20, sides: 6, rotate: [0, 0, 90], at: [`=${noseX("hw * 0.56")} + 0.005`, "=yLamp", "=(index == 0 ? 1 : -1) * hw * 0.56"], region: "trim" },
        { id: "tailLamps", type: "mesh.sphere", output: false, repeat: 2, radius: 0.05, segments: 12, rings: 6, at: [`=${noseX("hw * 0.8")} - 0.012`, "=yLamp", "=(index == 0 ? 1 : -1) * hw * 0.8"], region: "tail" },
        { id: "signShape", type: "curve.points", output: false, closed: true, points: noseStrip("signW", "0.018", "0.03", "0", "rake") },
        { id: "sign", type: "mesh.extrude", output: false, when: "=destinationSign && signH >= 0.1", outline: "@signShape", height: "=signH", smoothAngle: 40, at: [0, "=yCT + (lbH - signH) / 2", 0], region: "sign" },
        { id: "signBezelShape", type: "curve.points", output: false, closed: true, points: noseStrip("signW + 0.08", "0.008", "0.03", "0", "rake") },
        { id: "signBezel", type: "mesh.extrude", output: false, when: "=destinationSign && signH >= 0.1", outline: "@signBezelShape", height: "=signH + 0.06", smoothAngle: 40, at: [0, "=yCT + (lbH - signH) / 2 - 0.03", 0], region: "trim" },
        { id: "mirrorArmPath", type: "path.points", output: false, fillet: 0.08, filletSegments: 4, points: [[0.25, "=yBelt + 0.25", "=hw - 0.01"], [0.32, "=yBelt + 0.42", "=hw + 0.16"], [0.42, "=yBelt + 0.42", "=hw + 0.34"]] },
        { id: "mirrorArm", type: "mesh.sweep", output: false, path: "@mirrorArmPath", radius: 0.022, sides: 8 },
        { id: "mirrorHead", type: "mesh.box", output: false, size: [0.07, 0.34, 0.2], radius: 0.03, segments: 2, at: [0.44, "=yBelt + 0.42", "=hw + 0.38"] },
        { id: "mirrorUnit", type: "geo.join", output: false, meshes: ["@mirrorArm", "@mirrorHead"] },
        { id: "mirrorsPlaced", type: "geo.transform", output: false, when: "=mirrors", repeat: 2, mesh: "@mirrorUnit", scale: [1, 1, "=index == 0 ? 1 : -1"], region: "trim" },
        // Wipers parked across the foot of the windscreen, lying on the glass.
        {
            id: "wiperPath", type: "path.points", output: false, points: [
                [`=${noseX("hw * 0.36", "-0.012")}`, "=yBelt + 0.07", "=hw * 0.36"],
                [`=lerp(${noseX("hw * 0.36 - 0.42", "-0.012")}, ${noseX("hw * 0.36 - 0.42", "-0.012", "rake")}, 0.3)`, "=yBelt + 0.07 + 0.3 * (yCT - yBelt - 0.07)", "=hw * 0.36 - 0.42"],
            ],
        },
        { id: "wiper", type: "mesh.sweep", output: false, path: "@wiperPath", radius: 0.012, sides: 6 },
        { id: "wipers", type: "geo.transform", output: false, repeat: 2, mesh: "@wiper", scale: [1, 1, "=index == 0 ? 1 : -1"], region: "desk" },
        // A heritage lifeguard: slats across the nose just above the rails, on two hangers.
        { id: "lifeguardSlats", type: "mesh.box", output: false, when: "=lifeguard", repeat: 5, size: [0.045, 0.03, "=hw * 1.3"], radius: 0.01, segments: 1, at: [`=${noseX("0")} - 0.28 + index * 0.11`, "=yR + 0.15 + index * 0.012", 0], region: "bogie" },
        { id: "lifeguardRails", type: "mesh.box", output: false, when: "=lifeguard", repeat: 2, size: [0.6, 0.05, 0.04], at: [`=${noseX("0")} - 0.1`, "=yR + 0.16", "=(index == 0 ? 1 : -1) * hw * 0.62"], region: "bogie" },
        { id: "lifeguardHangers", type: "mesh.box", output: false, when: "=lifeguard", repeat: 2, size: [0.05, "=ySk + 0.08 - yR - 0.16", 0.04], at: [`=${noseX("hw * 0.62")} - 0.2`, "=(ySk + 0.08 + yR + 0.16) / 2", "=(index == 0 ? 1 : -1) * hw * 0.62"], region: "bogie" },
        { id: "coupler", type: "mesh.box", output: false, size: [0.22, 0.16, 0.36], radius: 0.04, segments: 2, at: [`=${noseX("0")} - 0.05`, "=ySk + 0.11", 0], region: "trim" },
        // Inside the cab: floor, ceiling, partition, desk and the driver's seat.
        { id: "cabFloorShape", type: "curve.points", output: false, closed: true, points: nosePlan("th") },
        { id: "cabFloor", type: "mesh.extrude", output: false, outline: "@cabFloorShape", height: 0.12, at: [0, "=yF - 0.12", 0], region: "floor" },
        { id: "cabCeilingShape", type: "curve.points", output: false, closed: true, points: nosePlan("th", "rake") },
        { id: "cabCeiling", type: "mesh.extrude", output: false, when: "=roofShown", outline: "@cabCeilingShape", height: 0.03, at: [0, "=yE - 0.03", 0], region: "interior" },
        { id: "partitionShape", type: "curve.points", output: false, closed: true, points: [["=-hwi", "=yF"], [-0.36, "=yF"], [-0.36, "=yF + min(1.95, interiorHeight - 0.08)"], [0.36, "=yF + min(1.95, interiorHeight - 0.08)"], [0.36, "=yF"], ["=hwi", "=yF"], ["=hwi", "=yE"], ["=-hwi", "=yE"]] },
        { id: "partitionLight", type: "curve.rect", output: false, width: "=hwi - 0.56", height: "=min(wh, yE - yW0 - 0.1)", radius: 0.04, cornerSegments: 4 },
        { id: "partitionLightAt", type: "curve.transform", output: false, curve: "@partitionLight", offset: [0, "=yW0 + min(wh, yE - yW0 - 0.1) / 2"] },
        { id: "partitionLights", type: "curves.linear", output: false, curve: "@partitionLightAt", count: 2, offset: ["=hwi + 0.36", 0] },
        { id: "partition", type: "mesh.extrude", output: false, when: "=cabPartition", outline: "@partitionShape", holes: ["@partitionLights"], height: 0.05, rotate: [-90, -90, 0], region: "interior" },
        { id: "partitionGlass", type: "mesh.extrude", output: false, when: "=cabPartition", repeat: 2, outline: "@partitionLightAt", height: 0.012, rotate: [-90, -90, 0], at: [0.019, 0, "=(index == 0 ? 1 : -1) * (hwi + 0.36) / 2"], region: "glass" },
        { id: "deskBody", type: "mesh.box", output: false, size: [0.5, 0.74, "=2 * dhw"], radius: 0.03, segments: 2, at: ["=xd - 0.25", "=yF + 0.37", 0], region: "desk" },
        { id: "deskTop", type: "mesh.box", output: false, size: [0.56, 0.05, "=2 * dhw - 0.02"], radius: 0.015, segments: 1, rotate: [0, 0, -14], at: ["=xd - 0.27", "=yF + 0.8", 0], region: "desk" },
        { id: "deskScreens", type: "mesh.box", output: false, when: "=cabStyle == 'modern'", repeat: 2, size: [0.02, 0.17, 0.26], rotate: [0, 0, 24], at: ["=xd - 0.12", "=yF + 0.93", "=(index == 0 ? 1 : -1) * min(0.3, dhw - 0.16)"], region: "screens" },
        { id: "deskLever", type: "mesh.box", output: false, when: "=cabStyle == 'modern'", size: [0.12, 0.05, 0.05], radius: 0.02, segments: 2, rotate: [0, 0, 20], at: ["=xd - 0.42", "=yF + 0.86", "=-min(0.25, dhw - 0.1)"], region: "controller" },
        { id: "controllerColumn", type: "mesh.cylinder", output: false, when: "=cabStyle == 'classic'", radius: 0.13, height: 1.0, segments: 18, bevel: 0.03, at: ["=xd - 0.62", "=yF", "=-min(0.3, dhw - 0.1)"], region: "controller" },
        { id: "controllerHandle", type: "mesh.box", output: false, when: "=cabStyle == 'classic'", size: [0.3, 0.04, 0.05], radius: 0.015, segments: 2, rotate: [0, 35, 0], at: ["=xd - 0.72", "=yF + 1.04", "=-min(0.3, dhw - 0.1) + 0.06"], region: "trim" },
        { id: "brakeWheel", type: "mesh.torus", output: false, when: "=cabStyle == 'classic'", major: 0.2, minor: 0.018, segments: 24, sides: 6, at: ["=xd - 0.6", "=yF + 1.05", "=min(0.3, dhw - 0.1)"], region: "controller" },
        { id: "brakeShaft", type: "mesh.cylinder", output: false, when: "=cabStyle == 'classic'", radius: 0.025, height: 1.05, segments: 10, at: ["=xd - 0.6", "=yF", "=min(0.3, dhw - 0.1)"], region: "controller" },
        { id: "driverCushion", type: "mesh.box", output: false, size: [0.46, 0.1, 0.5], radius: 0.04, segments: 2, at: ["=xd - 0.88", "=yF + 0.5", 0], region: "seat" },
        { id: "driverBack", type: "mesh.box", output: false, size: [0.09, 0.62, 0.48], radius: 0.04, segments: 2, rotate: [0, 0, 10], at: ["=xd - 1.12", "=yF + 0.85", 0], region: "seat" },
        { id: "driverPost", type: "mesh.cylinder", output: false, radius: 0.045, height: 0.45, segments: 12, at: ["=xd - 0.88", "=yF", 0], region: "seatFrame" },
        {
            id: "noseKit", type: "geo.join", output: false,
            meshes: ["@dash", "@screenBand", "@letterboard", "@noseStripe", "@bumperBand", "@noseRoof", "@pillarsB", "@pillarsA", "@pillarC", "@pillars3", "@headlamps", "@headlampRims", "@tailLamps",
                "@sign", "@signBezel", "@mirrorsPlaced", "@wipers", "@lifeguardSlats", "@lifeguardRails", "@lifeguardHangers", "@coupler", "@cabFloor", "@cabCeiling", "@partition", "@partitionGlass", "@deskBody", "@deskTop", "@deskScreens", "@deskLever",
                "@controllerColumn", "@controllerHandle", "@brakeWheel", "@brakeShaft", "@driverCushion", "@driverBack", "@driverPost"],
        },
        { id: "cabs", type: "geo.transform", repeat: 2, mesh: "@noseKit", scale: ["=index == 0 ? 1 : -1", 1, 1], at: ["=index == 0 ? xE : -xE", 0, 0] },
    ],
    limits: { maxSize: 95, minSize: 8, maxTriangles: 450000 },
};

export default streetCarDef;
