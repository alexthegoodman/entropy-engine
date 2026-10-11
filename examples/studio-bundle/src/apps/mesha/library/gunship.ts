import type { ObjectDef } from "../mesha_object";

// A military rotorcraft of a spacefaring surface: a gunship or a troop dropship. Nose toward +Z,
// skids on the ground at the origin, the main rotor turning about the mast at (0, mastTop, mastZ).
//
//                 ___________________________          main rotor (region "rotor": games spin it)
//                        _||_
//          ____.--------'    '------.______
//        ,'  canopy  :  engines   :        `--.__________      tail boom, fin, ducted tail fan
//       (  ==  [door / bay]  ==            __.-'---------[O]  (region "tailrotor")
//        `--.______________________,--''
//          |   stub wing + pods   |
//      ====|======================|====                    skids
//
// The fuselage is a lathe (revolved profile) laid along Z and squashed to its width and height;
// a dropship's cabin is fuller and longer, with a side bay that can stand open (its door slid back
// over the hull). A gunship carries stub wings with rocket pods, a chin gun and a sensor ball.
// Every light is a glow material: the searchlight, navigation lights and the beacon.

const pt = (y: string, r: string): [string, string] => [`=${r}`, `=${y}`];

export const gunshipDef: ObjectDef = {
    id: "transport.gunship",
    name: "Rotorcraft",
    category: "Transport",
    tags: ["helicopter", "gunship", "dropship", "rotorcraft", "vtol", "aircraft", "military", "chopper", "transport", "sci-fi", "army", "rotor"],
    description: "A military helicopter: a gunship with stub wings, rocket pods, a chin gun and a sensor ball, or a troop dropship with a side bay that can stand open. Ducted tail fan, twin engines, skids or wheels, searchlight and navigation lights.",
    featured: ["role", "length", "blades", "rotorDiameter", "bayOpen", "finish"],
    groups: [
        { id: "airframe", label: "Airframe" },
        { id: "rotor", label: "Rotors" },
        { id: "kit", label: "Equipment" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "role", label: "Role", type: "enum", default: "gunship", options: ["gunship", "dropship"], optionLabels: ["Gunship", "Troop dropship"], group: "airframe" },
        { id: "length", label: "Length", type: "number", default: 17, min: 12, max: 24, unit: "m", group: "airframe", description: "Nose to tail fin." },
        { id: "girth", label: "Cabin girth", type: "number", default: 1, min: 0.8, max: 1.3, group: "airframe", description: "Fuselage width and height relative to the role's own." },
        { id: "gear", label: "Landing gear", type: "enum", default: "skids", options: ["skids", "wheels"], optionLabels: ["Skids", "Wheels"], group: "airframe" },
        { id: "blades", label: "Main rotor blades", type: "int", default: 4, min: 2, max: 7, group: "rotor" },
        { id: "rotorDiameter", label: "Rotor diameter", type: "number", default: 15, min: 10, max: 22, unit: "m", group: "rotor" },
        { id: "bladeChord", label: "Blade chord", type: "number", default: 0.55, min: 0.3, max: 0.9, unit: "m", group: "rotor" },
        { id: "tailFan", label: "Tail fan blades", type: "int", default: 9, min: 5, max: 14, group: "rotor" },
        { id: "bayOpen", label: "Bay open", type: "bool", default: false, group: "kit", visibleIf: "=role == 'dropship'", description: "The side doors slid back, the troop bay dark inside." },
        { id: "pods", label: "Rocket pods", type: "int", default: 2, min: 0, max: 4, group: "kit", visibleIf: "=role == 'gunship'", description: "Per side, under the stub wings." },
        { id: "chinGun", label: "Chin gun", type: "bool", default: true, group: "kit", visibleIf: "=role == 'gunship'" },
        { id: "searchlight", label: "Searchlight", type: "bool", default: true, group: "kit" },
        { id: "finish", label: "Hull", type: "material", default: "composite.slate", materials: ["composite", "paint.black", "paint.navy", "paint.sage", "paint.white"], group: "materials" },
        { id: "accentFinish", label: "Trim", type: "material", default: "composite.black", materials: ["composite", "paint", "metal.gunmetal", "metal.black"], group: "materials" },
        { id: "glassFinish", label: "Canopy", type: "material", default: "glass.tinted", materials: ["glass.tinted", "glass.windowTinted", "glass.windowBronze", "glass.clear"], group: "materials" },
        { id: "lightFinish", label: "Searchlight", type: "material", default: "glow.white", materials: ["glow"], group: "materials" },
    ],
    derived: {
        L: "=length",
        drop: "=role == 'dropship'",
        hw: "=(role == 'dropship' ? 1.62 : 1.25) * girth * length / 17",
        hh: "=(role == 'dropship' ? 1.5 : 1.32) * girth * length / 17",
        clear: "=gear == 'wheels' ? 1.05 : 0.85",
        cy: "=clear + hh",
        noseZ: "=length * 0.42",
        podBack: "=-length * (role == 'dropship' ? 0.16 : 0.12)",
        mastZ: "=length * 0.05",
        mastTop: "=clear + hh * 2 + 0.75",
        tailZ: "=-length * 0.58",
        boomR: "=hh * 0.42",
        R: "=rotorDiameter / 2",
        fanR: "=0.62 * length / 17",
        fanY: "=clear + hh * 1.05 + 0.62 * length / 17",
        fanZ: "=-length * 0.58 + 0.62 * length / 17 * 1.15",
        bayZ: "=length * 0.06",
        bayLen: "=length * 0.26",
    },
    rules: [
        { check: "=rotorDiameter <= length * 1.15", message: "The main rotor would strike the tail fan." },
    ],
    regions: {
        hull: { label: "Hull", material: "=finish" },
        trim: { label: "Trim", material: "=accentFinish" },
        glass: { label: "Canopy", material: "=glassFinish" },
        dark: { label: "Intakes and bay", material: "metal.black" },
        rotor: { label: "Main rotor", material: "composite.black" },
        tailrotor: { label: "Tail fan", material: "composite.black" },
        gear: { label: "Gear", material: "metal.gunmetal" },
        tyre: { label: "Tyres", material: "rubber.black" },
        light: { label: "Searchlight", material: "=lightFinish" },
        navRed: { label: "Port light", material: "glow.red" },
        navGreen: { label: "Starboard light", material: "glow.green" },
        weapon: { label: "Weapons", material: "metal.gunmetal" },
    },
    presets: [
        { name: "Gunship", values: {} },
        { name: "Troop dropship", values: { role: "dropship", length: 19, blades: 5, rotorDiameter: 17, bayOpen: true, finish: "composite.slate" } },
        { name: "Desert gunship", values: { finish: "composite.sand", accentFinish: "composite.olive", pods: 3, blades: 5 } },
        { name: "Medevac", values: { role: "dropship", finish: "composite.white", accentFinish: "composite.orange", gear: "wheels", blades: 4 } },
        { name: "Night raider", values: { finish: "composite.black", accentFinish: "metal.gunmetal", glassFinish: "glass.windowBronze", blades: 6, rotorDiameter: 14 } },
    ],
    nodes: [
        // --- Fuselage: a revolved profile laid along Z (rotate x 90 takes +Y to +Z), squashed. ---
        {
            id: "pod", type: "mesh.lathe", segments: 28, smoothAngle: 60, region: "hull",
            profile: [
                pt("podBack - 0.01", "0"), pt("podBack", "0.5"), pt("podBack + L * 0.06", "0.84"), pt("podBack + L * 0.14", "0.98"),
                pt("L * 0.18", "1"), pt("L * 0.28", "0.93"), pt("L * 0.34", "0.78"), pt("L * 0.385", "0.55"), pt("noseZ - 0.12", "0.22"), pt("noseZ", "0"),
            ],
            rotate: [90, 0, 0], scale: ["=hw", 1, "=hh"], at: [0, "=cy", 0],
        },
        // A flatter belly keel and sponsons along the bottom.
        { id: "keel", type: "mesh.box", size: ["=hw * 1.5", "=hh * 0.35", "=L * 0.42"], radius: "=hh * 0.15", at: [0, "=clear + hh * 0.3", "=L * 0.08"], region: "trim" },
        // The canopy: a glazed bubble over the cockpit, framed.
        { id: "canopy", type: "mesh.sphere", radius: 1, segments: 24, rings: 14, scale: ["=hw * 0.82", "=hh * 0.62", "=L * 0.12"], at: [0, "=cy + hh * 0.38", "=L * 0.27"], region: "glass" },
        { id: "canopyFrame", type: "mesh.box", size: [0.08, "=hh * 0.5", 0.08], rotate: [-38, 0, 0], at: [0, "=cy + hh * 0.62", "=L * 0.31"], region: "trim" },
        // --- Tail: boom, fin, stabilizer, the ducted fan. ---
        {
            id: "boom", type: "mesh.sweep", sides: 16, profile: "@boomProfile", taper: 0.5, region: "hull",
            path: [[0, "=cy + hh * 0.2", "=podBack + 0.6"], [0, "=cy + hh * 0.55", "=podBack - L * 0.12"], [0, "=fanY - fanR * 0.1", "=fanZ + fanR * 0.6"]],
        },
        { id: "boomProfile", type: "curve.ellipse", output: false, rx: "=boomR * 1.1", ry: "=boomR", segments: 16 },
        // The fin stands on the duct, raked back; a ventral strake below.
        {
            id: "fin", type: "mesh.extrude", height: 0.26, bevel: 0.05, region: "hull",
            outline: [["=fanZ - fanR * 0.9", "=fanY + fanR * 0.7"], ["=fanZ + fanR * 1.3", "=fanY + fanR * 0.6"], ["=fanZ - fanR * 0.2", "=fanY + fanR * 3.6"], ["=fanZ - fanR * 1.25", "=fanY + fanR * 3.7"], ["=fanZ - fanR * 1.45", "=fanY + fanR * 0.9"]],
            rotate: [-90, -90, 0], at: [-0.13, 0, 0],
        },
        {
            id: "strake", type: "mesh.extrude", height: 0.16, bevel: 0.03, region: "hull",
            outline: [["=fanZ - fanR * 0.6", "=fanY - fanR * 0.8"], ["=fanZ + fanR * 0.9", "=fanY - fanR * 0.8"], ["=fanZ - fanR * 0.4", "=fanY - fanR * 1.9"], ["=fanZ - fanR * 0.9", "=fanY - fanR * 1.8"]],
            rotate: [-90, -90, 0], at: [-0.08, 0, 0],
        },
        { id: "duct", type: "mesh.torus", major: "=fanR * 1.05", minor: "=fanR * 0.26", segments: 28, sides: 10, scale: [1, 2.4, 1], rotate: [0, 0, 90], at: [0, "=fanY", "=fanZ"], region: "hull" },
        {
            id: "fanBlade", type: "mesh.box", output: false, size: ["=fanR * 0.95", 0.04, 0.14], at: ["=fanR * 0.48", 0, 0], rotate: [22, 0, 0],
        },
        { id: "fan", type: "instance.radial", mesh: "@fanBlade", count: "=tailFan", rotate: [0, 0, 90], at: [0, "=fanY", "=fanZ"], region: "tailrotor" },
        { id: "fanHub", type: "mesh.cylinder", radius: "=fanR * 0.2", height: 0.36, segments: 12, rotate: [0, 0, 90], at: [0.18, "=fanY", "=fanZ"], region: "tailrotor" },
        { id: "stab", type: "mesh.box", size: ["=hw * 2.4", 0.12, "=L * 0.05"], radius: 0.04, at: [0, "=fanY - fanR * 0.2", "=fanZ + fanR * 2.6"], region: "hull" },
        { id: "stabFins", type: "mesh.box", repeat: 2, size: [0.1, "=fanR * 1.4", "=L * 0.05"], radius: 0.03, at: ["=(index == 0 ? 1 : -1) * hw * 1.2", "=fanY + fanR * 0.3", "=fanZ + fanR * 2.6"], region: "hull" },
        // --- Engines on the roof, either side of the mast, with intakes and exhausts. ---
        {
            id: "engine", type: "mesh.lathe", output: false, segments: 16, smoothAngle: 50,
            profile: [pt("-L * 0.13", "0"), pt("-L * 0.13", "0.28"), pt("-L * 0.1", "0.38"), pt("L * 0.08", "0.42"), pt("L * 0.12", "0.36"), pt("L * 0.12", "0")],
            rotate: [90, 0, 0],
        },
        { id: "engines", type: "instance.onPoints", mesh: "@engine", points: [["=hw * 0.42", "=cy + hh * 0.88", "=-L * 0.02"], ["=-hw * 0.42", "=cy + hh * 0.88", "=-L * 0.02"]], region: "trim" },
        { id: "intakes", type: "mesh.cylinder", repeat: 2, radius: 0.3, height: 0.06, segments: 14, rotate: [90, 0, 0], at: ["=(index == 0 ? 1 : -1) * hw * 0.42", "=cy + hh * 0.88", "=L * 0.1 + 0.1"], region: "dark" },
        { id: "exhausts", type: "mesh.cylinder", repeat: 2, radius: 0.24, height: 0.08, segments: 14, rotate: [90, 0, 0], at: ["=(index == 0 ? 1 : -1) * hw * 0.42", "=cy + hh * 0.88", "=-L * 0.13 - 0.06"], region: "dark" },
        // --- Main rotor: mast, hub, blades (region "rotor"). ---
        { id: "mast", type: "mesh.cylinder", radius: 0.2, height: "=mastTop - (cy + hh * 0.85)", segments: 14, at: [0, "=cy + hh * 0.85", "=mastZ"], region: "trim" },
        { id: "hub", type: "mesh.cylinder", radius: 0.5, height: 0.32, segments: 18, bevel: 0.1, at: [0, "=mastTop - 0.1", "=mastZ"], region: "rotor" },
        {
            id: "blade", type: "mesh.box", output: false, size: ["=bladeChord", 0.07, "=R - 0.4"], radius: 0.02,
            at: [0, "=-(R - 0.4) * 0.03", "=(R - 0.4) / 2 + 0.4"], rotate: [-3, 0, 0],
        },
        { id: "rotorBlades", type: "instance.radial", mesh: "@blade", count: "=blades", at: [0, "=mastTop + 0.05", "=mastZ"], region: "rotor" },
        // --- Gunship: stub wings, pods, chin gun, sensor ball. ---
        {
            id: "wing", type: "mesh.box", repeat: 2, when: "=!drop", size: ["=hw * 1.5", 0.16, "=L * 0.075"], radius: 0.05,
            rotate: [0, 0, "=index == 0 ? -6 : 6"], at: ["=(index == 0 ? 1 : -1) * hw * 1.55", "=cy - hh * 0.1", "=L * 0.02"], region: "hull",
        },
        {
            id: "podProfile", type: "mesh.lathe", output: false, segments: 14,
            profile: [[0, 0], [0.22, 0], [0.24, 0.1], [0.24, 1.5], [0.17, 1.75], [0, 1.82]], rotate: [90, 0, 0],
        },
        {
            id: "rocketPods", type: "instance.onPoints", when: "=!drop && pods > 0", mesh: "@podProfile",
            points: { switch: "=pods", cases: {
                "1": [["=hw * 1.85", "=cy - hh * 0.38", "=L * -0.02"], ["=-hw * 1.85", "=cy - hh * 0.38", "=L * -0.02"]],
                "2": [["=hw * 1.35", "=cy - hh * 0.36", "=L * -0.02"], ["=hw * 2.05", "=cy - hh * 0.42", "=L * -0.02"], ["=-hw * 1.35", "=cy - hh * 0.36", "=L * -0.02"], ["=-hw * 2.05", "=cy - hh * 0.42", "=L * -0.02"]],
                "3": [["=hw * 1.2", "=cy - hh * 0.34", "=L * -0.02"], ["=hw * 1.7", "=cy - hh * 0.39", "=L * -0.02"], ["=hw * 2.2", "=cy - hh * 0.44", "=L * -0.02"], ["=-hw * 1.2", "=cy - hh * 0.34", "=L * -0.02"], ["=-hw * 1.7", "=cy - hh * 0.39", "=L * -0.02"], ["=-hw * 2.2", "=cy - hh * 0.44", "=L * -0.02"]],
            }, default: [["=hw * 1.15", "=cy - hh * 0.34", "=L * -0.02"], ["=hw * 1.55", "=cy - hh * 0.38", "=L * -0.02"], ["=hw * 1.95", "=cy - hh * 0.42", "=L * -0.02"], ["=hw * 2.35", "=cy - hh * 0.46", "=L * -0.02"], ["=-hw * 1.15", "=cy - hh * 0.34", "=L * -0.02"], ["=-hw * 1.55", "=cy - hh * 0.38", "=L * -0.02"], ["=-hw * 1.95", "=cy - hh * 0.42", "=L * -0.02"], ["=-hw * 2.35", "=cy - hh * 0.46", "=L * -0.02"]] },
            region: "weapon",
        },
        { id: "sensorBall", type: "mesh.sphere", when: "=!drop", radius: 0.42, segments: 16, rings: 10, at: [0, "=clear + hh * 0.45", "=L * 0.385"], region: "trim" },
        { id: "sensorEye", type: "mesh.sphere", when: "=!drop", radius: 0.2, segments: 12, rings: 8, at: [0, "=clear + hh * 0.45", "=L * 0.385 + 0.3"], region: "glass" },
        { id: "chinTurret", type: "mesh.cylinder", when: "=!drop && chinGun", radius: 0.32, height: 0.3, segments: 14, at: [0, "=clear + hh * 0.08", "=L * 0.3"], region: "weapon" },
        { id: "chinBarrels", type: "mesh.cylinder", when: "=!drop && chinGun", repeat: 3, radius: 0.045, height: 1.6, segments: 8, rotate: [90, 0, 0], at: ["=(index - 1) * 0.08", "=clear + hh * 0.18 + (index % 2) * 0.05", "=L * 0.3"], region: "weapon" },
        // --- Dropship: the side bay, dark inside, its doors slid back over the hull when open. ---
        { id: "bayDark", type: "mesh.box", repeat: 2, when: "=drop && bayOpen", size: [0.1, "=hh * 1.05", "=bayLen"], at: ["=(index == 0 ? 1 : -1) * (hw * 0.97)", "=cy - hh * 0.05", "=bayZ"], region: "dark" },
        { id: "bayFrame", type: "mesh.box", repeat: 4, when: "=drop", size: [0.14, "=hh * 1.12", 0.12], at: ["=(index < 2 ? 1 : -1) * hw * 0.99", "=cy - hh * 0.05", "=bayZ + (index % 2 == 0 ? 1 : -1) * bayLen / 2"], region: "trim" },
        { id: "doors", type: "mesh.box", repeat: 2, when: "=drop", size: [0.09, "=hh * 1.05", "=bayLen"], radius: 0.03,
            at: ["=(index == 0 ? 1 : -1) * (hw * 1.03)", "=cy - hh * 0.05", "=bayZ - (bayOpen ? bayLen * 0.92 : 0)"], region: "hull" },
        { id: "doorWindows", type: "mesh.box", repeat: 2, when: "=drop", size: [0.04, "=hh * 0.28", "=bayLen * 0.5"],
            at: ["=(index == 0 ? 1 : -1) * (hw * 1.08)", "=cy + hh * 0.2", "=bayZ - (bayOpen ? bayLen * 0.92 : 0)"], region: "glass" },
        { id: "sponsons", type: "mesh.box", repeat: 2, when: "=drop", size: ["=hw * 0.35", "=hh * 0.4", "=L * 0.2"], radius: 0.12, at: ["=(index == 0 ? 1 : -1) * hw * 1.05", "=clear + hh * 0.35", "=-L * 0.06"], region: "trim" },
        // --- Gear. ---
        {
            id: "skids", type: "mesh.sweep", repeat: 2, when: "=gear == 'skids'", radius: 0.075, sides: 10, region: "gear",
            path: [["=(index == 0 ? 1 : -1) * hw * 0.95", 0.08, "=-L * 0.16"], ["=(index == 0 ? 1 : -1) * hw * 0.95", 0.08, "=L * 0.2"], ["=(index == 0 ? 1 : -1) * hw * 0.95", 0.2, "=L * 0.25"], ["=(index == 0 ? 1 : -1) * hw * 0.95", 0.42, "=L * 0.27"]],
        },
        {
            id: "struts", type: "mesh.sweep", repeat: 4, when: "=gear == 'skids'", radius: 0.07, sides: 8, region: "gear",
            path: [["=(index < 2 ? 1 : -1) * hw * 0.95", 0.08, "=(index % 2 == 0 ? L * 0.13 : -L * 0.09)"], ["=(index < 2 ? 1 : -1) * hw * 0.55", "=clear + hh * 0.3", "=(index % 2 == 0 ? L * 0.12 : -L * 0.08)"]],
        },
        { id: "wheels", type: "mesh.cylinder", repeat: 3, when: "=gear == 'wheels'", radius: 0.38, height: 0.28, segments: 18, bevel: 0.08,
            rotate: [0, 0, 90], at: ["=index == 2 ? 0.14 : (index == 0 ? 1 : -1) * hw * 0.8 + (index == 0 ? 0.14 : -0.14)", 0.38, "=index == 2 ? L * 0.28 : -L * 0.06"], region: "tyre" },
        { id: "legs", type: "mesh.cylinder", repeat: 3, when: "=gear == 'wheels'", radius: 0.08, height: "=clear + hh * 0.3 - 0.38", segments: 8,
            at: ["=index == 2 ? 0 : (index == 0 ? 1 : -1) * hw * 0.8", 0.38, "=index == 2 ? L * 0.28 : -L * 0.06"], region: "gear" },
        // --- Lights. ---
        { id: "lamp", type: "mesh.cylinder", when: "=searchlight", radius: 0.22, height: 0.3, segments: 14, rotate: [70, 0, 0], at: [0, "=clear + hh * 0.2", "=L * 0.36"], region: "trim" },
        { id: "lens", type: "mesh.cylinder", when: "=searchlight", radius: 0.18, height: 0.04, segments: 14, rotate: [70, 0, 0], at: [0, "=clear + hh * 0.2 - 0.27", "=L * 0.36 + 0.1"], region: "light" },
        { id: "navPort", type: "mesh.sphere", radius: 0.09, segments: 8, rings: 6, at: ["=drop ? -hw * 1.25 : -hw * 2.28", "=drop ? clear + hh * 0.55 : cy - hh * 0.22", "=drop ? -L * 0.06 : L * 0.02"], region: "navRed" },
        { id: "navStarboard", type: "mesh.sphere", radius: 0.09, segments: 8, rings: 6, at: ["=drop ? hw * 1.25 : hw * 2.28", "=drop ? clear + hh * 0.55 : cy - hh * 0.22", "=drop ? -L * 0.06 : L * 0.02"], region: "navGreen" },
        { id: "beacon", type: "mesh.sphere", radius: 0.1, segments: 8, rings: 6, at: [0, "=cy + hh * 1.02", "=-L * 0.16"], region: "navRed" },
        { id: "tailLight", type: "mesh.sphere", radius: 0.08, segments: 8, rings: 6, at: [0, "=fanY + fanR * 3.65", "=fanZ - fanR * 1.25"], region: "light" },
    ],
    limits: { maxSize: 28, minSize: 6, maxTriangles: 60000 },
};

export default gunshipDef;
