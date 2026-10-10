import type { ObjectDef } from "../mesha_object";

// An abandoned car hulk. Front toward +Z, standing on the ground at the origin. The body is two
// side profiles extruded across the car (the house's wall convention: rotate [-90, -90, 0] runs an
// outline's (u, v) along (+Z, up) with its thickness toward +X): a lower body with real wheel
// arches and a recessed engine bay under a hood panel, and a narrower greenhouse whose shape is the
// body style. Windows are panes on the greenhouse; a broken one shows the dark cabin instead.
//
//              ____________
//             /  |      |  \______        greenhouse (sedan, hatchback, pickup cab, van)
//      ______/___|______|___\_____\__     belt line; hood hinged at the cowl
//     |   _                    _     |    lower body with arches
//     '--/ \------------------/ \----'
//        \_/                  \_/         wheels (missing ones drop their corner)
//
// Everything is joined and tipped at the end: a missing wheel drops its corner, Roll leans it, Sink
// settles it into the dirt.

const L = "length", W = "width";
const arch = (cu: string, n = 8): [string, string][] =>
    Array.from({ length: n + 1 }, (_, j) => {
        const a = `(180 + archDip - (180 + 2 * archDip) * ${j / n})`;
        return [`=${cu} + archR * cos(rad(${a}))`, `=wr + archR * sin(rad(${a}))`] as [string, string];
    });

export const wreckCarDef: ObjectDef = {
    id: "transport.wreck_car",
    name: "Wrecked Car",
    category: "Transport",
    tags: ["car", "wreck", "wrecked", "hulk", "abandoned", "rusted", "rust", "burnt", "sedan", "hatchback", "pickup", "truck", "van", "vehicle", "post-apocalyptic", "apocalyptic", "wasteland", "junk", "scrap"],
    description: "A rusting car hulk: sedan, hatchback, pickup or van, with flat or missing wheels that tip it over, smashed glass, a sprung hood, a salvaged door and junk on the roof. It can be burnt out.",
    featured: ["style", "length", "missingWheels", "brokenGlass", "hoodOpen", "burnt", "bodyFinish"],
    groups: [
        { id: "body", label: "Body" },
        { id: "wreck", label: "Wreckage" },
        { id: "extras", label: "Junk" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "style", label: "Body style", type: "enum", default: "sedan", options: ["sedan", "hatchback", "pickup", "van"], optionLabels: ["Sedan", "Hatchback", "Pickup", "Van"], group: "body" },
        { id: "length", label: "Length", type: "number", default: 4.5, min: 3.6, max: 5.6, unit: "m", group: "body" },
        { id: "width", label: "Width", type: "number", default: 1.78, min: 1.6, max: 2.0, unit: "m", group: "body" },
        { id: "roofHeight", label: "Roof height", type: "number", default: 1, min: 0.85, max: 1.2, group: "body", description: "Cabin height relative to the style's own." },
        { id: "wheelSize", label: "Wheel diameter", type: "number", default: 0.64, min: 0.55, max: 0.8, unit: "m", group: "body" },
        { id: "missingWheels", label: "Missing wheels", type: "int", default: 1, min: 0, max: 4, group: "wreck", description: "Gone from the front left first; the corner drops onto its hub." },
        { id: "flatTyres", label: "Flat tyres", type: "bool", default: true, group: "wreck" },
        { id: "brokenGlass", label: "Broken glass", type: "number", default: 0.6, min: 0, max: 1, group: "wreck" },
        { id: "hoodOpen", label: "Hood sprung", type: "number", default: 0, min: 0, max: 70, unit: "deg", group: "wreck" },
        { id: "roll", label: "Roll", type: "number", default: 0, min: -14, max: 14, unit: "deg", group: "wreck" },
        { id: "sink", label: "Sunk in", type: "number", default: 0.04, min: 0, max: 0.3, unit: "m", group: "wreck" },
        { id: "burnt", label: "Burnt out", type: "bool", default: false, group: "wreck" },
        { id: "salvagedDoor", label: "Salvaged door", type: "bool", default: true, group: "extras", visibleIf: "=!burnt" },
        { id: "roofLoad", label: "Junk on the roof", type: "bool", default: false, group: "extras" },
        { id: "bodyFinish", label: "Body", type: "material", default: "metal.rustRed", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "paint.sage", "paint.navy", "paint.terracotta", "paint.cream", "paint.teal", "paint.brunswick"], group: "materials" },
        { id: "patchFinish", label: "Salvaged door", type: "material", default: "metal.rustYellow", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "paint.sage", "paint.navy", "paint.terracotta", "paint.cream", "paint.teal"], group: "materials", visibleIf: "=salvagedDoor && !burnt" },
        { id: "trimFinish", label: "Bumpers and rims", type: "material", default: "metal.rust", materials: ["metal.rust", "metal.chrome", "metal.black", "plastic.black"], group: "materials" },
        { id: "glassFinish", label: "Glass", type: "material", default: "glass.windowTinted", materials: ["glass"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 3, group: "materials", variation: 0 },
    ],
    derived: {
        si: "=style == 'sedan' ? 0 : style == 'hatchback' ? 1 : style == 'pickup' ? 2 : 3",
        isVan: "=style == 'van'", isPickup: "=style == 'pickup'",
        wr: "=wheelSize / 2", archR: "=wheelSize / 2 + 0.05", yb: "=wheelSize / 2 * 0.72",
        archDip: "=deg(atan2(wheelSize / 2 * 0.28, sqrt(pow(wheelSize / 2 + 0.05, 2) - pow(wheelSize / 2 * 0.28, 2))))",
        belt: "=wheelSize / 2 * 0.72 + select(si, 0.52, 0.52, 0.58, 0.62)",
        cabH: "=select(si, 0.52, 0.56, 0.56, 1.05) * roofHeight",
        roofY: "=belt + cabH",
        wb: "=length * select(si, 0.6, 0.62, 0.62, 0.6)",
        wsB: "=length * select(si, 0.17, 0.2, 0.13, 0.36)", roofF: "=length * select(si, -0.02, 0.03, -0.02, 0.27)",
        roofR: "=select(si, -length * 0.22, -length * 0.38, -length * 0.13, -length / 2 + 0.08)",
        rwB: "=select(si, -length * 0.33, -length / 2 + 0.07, -length * 0.15, -length / 2 + 0.04)",
        cw: "=width * 0.86",
        bedFloor: "=wheelSize / 2 * 0.72 + 0.3",
        topRear: "=isPickup ? bedFloor : belt",
        cabBack: "=isPickup ? rwB - 0.05 : rwB",
        hl: "=length / 2 - 0.08 - (wsB - 0.05)",
        wsDy: "=roofY - belt - 0.03", wsDu: "=wsB - roofF", wsLen: "=hypot(roofY - belt - 0.03, wsB - roofF)", wsA: "=deg(atan2(roofY - belt - 0.03, wsB - roofF))",
        rwDu: "=roofR - rwB", rwLen: "=hypot(roofY - belt - 0.03, roofR - rwB)", rwA: "=-deg(atan2(roofY - belt - 0.03, roofR - rwB))",
        // Corners missing their wheel: 0 front left (+X), 1 front right, 2 rear left, 3 rear right.
        mFL: "=missingWheels > 0 ? 1 : 0", mFR: "=missingWheels > 1 ? 1 : 0", mRL: "=missingWheels > 2 ? 1 : 0", mRR: "=missingWheels > 3 ? 1 : 0",
        drop: "=wheelSize / 2 * 0.62",
        pitchA: "=deg(atan2(((missingWheels > 0 ? 1 : 0) + (missingWheels > 1 ? 1 : 0) - (missingWheels > 2 ? 1 : 0) - (missingWheels > 3 ? 1 : 0)) * wheelSize / 2 * 0.62 / 2, length * 0.6))",
        rollA: "=roll - deg(atan2(((missingWheels > 0 ? 1 : 0) - (missingWheels > 1 ? 1 : 0) + (missingWheels > 2 ? 1 : 0) - (missingWheels > 3 ? 1 : 0)) * wheelSize / 2 * 0.62 / 2, width))",
        settle: "=(missingWheels == 4 ? wheelSize / 2 * 0.62 : missingWheels > 0 ? wheelSize / 2 * 0.62 * 0.5 : 0) + (flatTyres || burnt ? wheelSize * 0.06 : 0)",
    },
    rules: [
        { check: "=hl > 0.35", message: "No room for a hood in front of the windscreen." },
        { check: "=roofF > roofR + 0.3", message: "The roof is too short." },
    ],
    regions: {
        body: { label: "Body", material: "=bodyFinish" },
        burnt: { label: "Burnt shell", material: "metal.rust" },
        patch: { label: "Salvaged door", material: "=patchFinish" },
        trim: { label: "Bumpers and rims", material: "=trimFinish" },
        glass: { label: "Glass", material: "=glassFinish" },
        hole: { label: "Dark cabin", material: "plastic.black" },
        tyres: { label: "Tyres", material: "rubber.black" },
        lights: { label: "Headlights", material: "glass.frosted" },
        tail: { label: "Tail lights", material: "plastic.red" },
        dark: { label: "Engine and chassis", material: "metal.black" },
        cargo: { label: "Cargo", material: "wood.weathered" },
        tarp: { label: "Tarp", material: "fabric.canvas" },
    },
    presets: [
        { name: "Rusted sedan", values: {} },
        { name: "Abandoned hatchback", values: { style: "hatchback", length: 3.9, width: 1.7, missingWheels: 0, brokenGlass: 0.3, bodyFinish: "paint.sage", salvagedDoor: false, roll: 3, seed: 8 } },
        { name: "Scavenger pickup", values: { style: "pickup", length: 5.2, width: 1.9, wheelSize: 0.76, missingWheels: 0, flatTyres: false, brokenGlass: 0.2, roofLoad: true, bodyFinish: "metal.rustYellow", patchFinish: "metal.rust", sink: 0, seed: 11 } },
        { name: "Burnt-out van", values: { style: "van", length: 5, width: 1.95, missingWheels: 2, burnt: true, brokenGlass: 1, sink: 0.12, seed: 4 } },
        { name: "Stripped hulk", values: { missingWheels: 4, hoodOpen: 55, brokenGlass: 1, bodyFinish: "metal.rust", trimFinish: "metal.black", sink: 0.15, roll: -4, seed: 19 } },
    ],
    nodes: [
        // ================= Lower body =================
        { id: "lowerProfile", type: "curve.points", output: false, closed: true, fillet: 0, filletSegments: 2, points: [
            [`=-${L} / 2`, "=yb + 0.12"], [`=-${L} / 2 + 0.12`, "=yb"],
            ...arch("(-wb / 2)"),
            ...arch("(wb / 2)"),
            [`=${L} / 2 - 0.12`, "=yb"], [`=${L} / 2`, "=yb + 0.14"], [`=${L} / 2`, "=belt - 0.22"], [`=${L} / 2 - 0.08`, "=belt - 0.12"],
            ["=wsB - 0.05", "=belt - 0.12"], ["=wsB - 0.05", "=belt"],
            ["=cabBack", "=belt"], ["=cabBack - (isPickup ? 0.001 : 0)", "=topRear"], [`=-${L} / 2 + 0.1`, "=topRear"], [`=-${L} / 2`, "=topRear - 0.1"],
        ] },
        { id: "lower", type: "mesh.extrude", output: false, outline: "@lowerProfile", height: `=${W}`, bevel: 0.02, bevelSegments: 1, rotate: [-90, -90, 0], at: [`=-${W} / 2`, 0, 0], region: "=burnt ? 'burnt' : 'body'" },
        // ================= Greenhouse =================
        { id: "cabinProfile", type: "curve.points", output: false, closed: true, fillet: 0.05, filletSegments: 2, points: [
            ["=wsB", "=belt - 0.02"], ["=roofF", "=roofY"], ["=roofR", "=roofY"], ["=rwB", "=belt - 0.02"],
        ] },
        { id: "cabin", type: "mesh.extrude", output: false, outline: "@cabinProfile", height: "=cw", bevel: 0.015, bevelSegments: 1, rotate: [-90, -90, 0], at: ["=-cw / 2", 0, 0], region: "=burnt ? 'burnt' : 'body'" },
        { id: "sideWindowProfile", type: "curve.points", output: false, closed: true, points: [
            ["=wsB - 0.14", "=belt + 0.06"], ["=roofF - 0.05", "=roofY - 0.07"],
            ["=isVan ? roofF - 0.8 : roofR + 0.05", "=roofY - 0.07"], ["=isVan ? roofF - 0.8 : rwB + 0.14", "=belt + 0.06"],
        ] },
        { id: "sideWindows", type: "mesh.extrude", output: false, repeat: 2, outline: "@sideWindowProfile", height: 0.015, rotate: [-90, -90, 0],
            at: ["=index == 0 ? cw / 2 : -cw / 2 - 0.015", 0, 0], region: "=burnt || rand(index, 31) < brokenGlass ? 'hole' : 'glass'" },
        { id: "bPillars", type: "mesh.box", output: false, when: "=!isVan", repeat: 2, size: [0.03, "=roofY - belt - 0.1", 0.09],
            at: ["=(index == 0 ? 1 : -1) * (cw / 2 + 0.018)", "=(roofY + belt) / 2", "=(roofF + roofR) / 2 + 0.1"], region: "=burnt ? 'burnt' : 'body'" },
        { id: "windscreen", type: "mesh.box", output: false, size: ["=cw - 0.14", 0.015, "=wsLen - 0.16"], rotate: ["=wsA", 0, 0],
            at: [0, "=(belt + roofY) / 2 + 0.012 * cos(rad(wsA))", "=(wsB + roofF) / 2 + 0.012 * sin(rad(wsA))"], region: "=burnt || rand(7, 32) < brokenGlass ? 'hole' : 'glass'" },
        { id: "rearWindow", type: "mesh.box", output: false, when: "=!isVan", size: ["=cw - 0.16", 0.015, "=rwLen - 0.16"], rotate: ["=rwA", 0, 0],
            at: [0, "=(belt + roofY) / 2 + 0.012 * cos(rad(rwA))", "=(rwB + roofR) / 2 + 0.012 * sin(rad(rwA))"], region: "=burnt || rand(8, 33) < brokenGlass ? 'hole' : 'glass'" },
        { id: "vanRearWindows", type: "mesh.box", output: false, when: "=isVan", repeat: 2, size: ["=cw * 0.36", "=cabH * 0.42", 0.015],
            at: ["=(index == 0 ? 1 : -1) * cw * 0.22", "=roofY - cabH * 0.32", "=rwB - 0.012"], region: "=burnt || rand(index + 9, 34) < brokenGlass ? 'hole' : 'glass'" },
        // ================= Hood and engine bay =================
        { id: "hood", type: "mesh.box", output: false, size: [`=${W} - 0.06`, 0.12, "=hl"], rotate: ["=-hoodOpen", 0, 0],
            at: [0, "=belt - 0.06 + sin(rad(hoodOpen)) * hl / 2", "=wsB - 0.05 + cos(rad(hoodOpen)) * hl / 2"], region: "=burnt ? 'burnt' : 'body'" },
        { id: "engine", type: "mesh.box", output: false, when: "=hoodOpen > 4", size: [`=${W} * 0.55`, 0.3, "=hl * 0.62"], radius: 0.03,
            at: [0, "=belt - 0.17", "=wsB + hl * 0.45"], region: "dark" },
        // ================= Trim =================
        { id: "bumpers", type: "mesh.box", output: false, repeat: 2, size: [`=${W} * 0.98`, 0.17, 0.13], radius: 0.03,
            rotate: [0, 0, "=(rand(index, 41) - 0.5) * 10"], at: [0, "=yb + 0.13", `=(index == 0 ? 1 : -1) * (${L} / 2 + 0.03)`], region: "trim" },
        { id: "grille", type: "mesh.box", output: false, size: [`=${W} * 0.42`, 0.16, 0.03], at: [0, "=belt - 0.24", `=${L} / 2 + 0.005`], region: "dark" },
        { id: "headlights", type: "mesh.box", output: false, repeat: 2, size: [0.28, 0.13, 0.03],
            at: [`=(index == 0 ? 1 : -1) * (${W} / 2 - 0.27)`, "=belt - 0.24", `=${L} / 2 + 0.008`], region: "=burnt || rand(index, 42) < brokenGlass * 0.6 ? 'hole' : 'lights'" },
        { id: "tailLights", type: "mesh.box", output: false, repeat: 2, size: [0.24, 0.16, 0.03],
            at: [`=(index == 0 ? 1 : -1) * (${W} / 2 - 0.2)`, "=topRear - 0.2", `=-${L} / 2 - 0.006`], region: "=burnt ? 'hole' : 'tail'" },
        { id: "doorPatch", type: "mesh.box", output: false, when: "=salvagedDoor && !burnt", size: [0.02, "=belt - yb - 0.12", "=min(1.05, wsB - roofR - 0.2)"],
            at: [`=(rand(1, 43) < 0.5 ? 1 : -1) * (${W} / 2 + 0.008)`, "=(belt + yb) / 2 + 0.02", "=wsB - 0.12 - min(1.05, wsB - roofR - 0.2) / 2"], region: "patch" },
        { id: "chassis", type: "mesh.box", output: false, size: [`=${W} * 0.8`, 0.12, `=${L} * 0.8`], at: [0, "=yb + 0.04", 0], region: "dark" },
        // Pickup bed walls and tailgate.
        { id: "bedSides", type: "mesh.box", output: false, when: "=isPickup", repeat: 2, size: [0.06, "=belt - bedFloor", `=cabBack + ${L} / 2 - 0.05`],
            at: [`=(index == 0 ? 1 : -1) * (${W} / 2 - 0.03)`, "=(belt + bedFloor) / 2", `=(cabBack - ${L} / 2) / 2 + 0.03`], region: "=burnt ? 'burnt' : 'body'" },
        { id: "tailgate", type: "mesh.box", output: false, when: "=isPickup", size: [`=${W} - 0.04`, "=belt - bedFloor", 0.06],
            at: [0, "=(belt + bedFloor) / 2", `=-${L} / 2 + 0.03`], region: "=burnt ? 'burnt' : 'body'" },
        // ================= Wheels =================
        { id: "tyres", type: "mesh.torus", output: false, when: "=!burnt", repeat: 4, keep: "=index >= missingWheels", major: "=wr * 0.66", minor: "=wr * 0.34", segments: 24, sides: 10,
            scale: ["=flatTyres ? 0.82 : 1", 1, 1], rotate: [0, 0, 90],
            at: [`=(index % 2 == 0 ? 1 : -1) * (${W} / 2 - wr * 0.3)`, "=flatTyres ? wr * 0.82 : wr", "=(index < 2 ? 1 : -1) * wb / 2"], region: "tyres" },
        { id: "rims", type: "mesh.cylinder", output: false, repeat: 4, keep: "=index >= missingWheels", radius: "=wr * 0.5", height: "=wr * 0.5", segments: 16, bevel: 0.02,
            rotate: [0, 0, 90],
            at: [`=(index % 2 == 0 ? 1 : -1) * (${W} / 2 - wr * 0.3) + wr * 0.25`, "=burnt ? wr * 0.5 : flatTyres ? wr * 0.82 : wr", "=(index < 2 ? 1 : -1) * wb / 2"], region: "trim" },
        { id: "hubs", type: "mesh.cylinder", output: false, repeat: 4, keep: "=index < missingWheels", radius: "=wr * 0.28", height: 0.16, segments: 12,
            rotate: [0, 0, 90], at: [`=(index % 2 == 0 ? 1 : -1) * (${W} / 2 - 0.2) + 0.08`, "=wr * 0.3", "=(index < 2 ? 1 : -1) * wb / 2"], region: "dark" },
        // ================= Roof junk =================
        { id: "rails", type: "mesh.box", output: false, when: "=roofLoad", repeat: 2, size: [0.04, 0.05, "=(roofF - roofR) * 0.9"], at: ["=(index == 0 ? 1 : -1) * cw * 0.4", "=roofY + 0.05", "=(roofF + roofR) / 2"], region: "trim" },
        { id: "roofCrates", type: "mesh.box", output: false, when: "=roofLoad", repeat: 2, size: ["=cw * 0.42", "=0.24 + index * 0.08", "=(roofF - roofR) * 0.38"], rotate: [0, "=(rand(index, 44) - 0.5) * 16", 0],
            at: ["=(index == 0 ? 1 : -1) * cw * 0.2", "=roofY + 0.08 + (0.24 + index * 0.08) / 2", "=(roofF + roofR) / 2 + (index - 0.5) * (roofF - roofR) * 0.3"], region: "cargo" },
        { id: "tarp", type: "mesh.box", output: false, when: "=roofLoad", size: ["=cw * 0.95", 0.12, "=(roofF - roofR) * 0.45"], radius: 0.05, rotate: [4, 0, -3],
            at: [0, "=roofY + 0.44", "=(roofF + roofR) / 2 - (roofF - roofR) * 0.12"], region: "tarp" },
        // ================= Tip it =================
        {
            id: "car", type: "geo.join",
            meshes: ["@lower", "@cabin", "@sideWindows", "@bPillars", "@windscreen", "@rearWindow", "@vanRearWindows", "@hood", "@engine", "@bumpers", "@grille", "@headlights", "@tailLights", "@doorPatch", "@chassis", "@bedSides", "@tailgate", "@tyres", "@rims", "@hubs", "@rails", "@roofCrates", "@tarp"],
            rotate: ["=pitchA", 0, "=rollA"], at: [0, "=-sink - settle", 0],
        },
    ],
    limits: { maxSize: 7, minSize: 2, maxTriangles: 30000, floor: false },
};

export default wreckCarDef;
