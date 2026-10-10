import type { ObjectDef } from "../mesha_object";

/**
 * A run of pipe from one connector convention: an outside diameter that sizes everything else
 * (flanges, bolt circles, bend radius, valves, supports). Layouts: straight, a 90° elbow, a tee, a
 * riser offset, an expansion loop. Bends follow a centre-line radius in pipe diameters; open ends
 * show the bore; flanged ends and joints carry bolt circles; an inline gate, ball or butterfly
 * valve; saddle supports or hangers; optional lagging. A visual kit: no flow or pressure rating.
 * The run is centred on the origin along X at `elevation`.
 */
const pipe: ObjectDef = {
    id: "mechanical.pipe",
    name: "Pipe, Elbow & Valve Kit",
    category: "Mechanical",
    tags: ["pipe", "pipes", "plumbing", "pipework", "elbow", "tee", "valve", "gate valve", "ball valve", "flange", "industrial", "factory", "utility", "duct"],
    description: "Pipe runs with bends, tees, flanges, valves and supports, sized from one diameter.",
    featured: ["layout", "length", "diameter", "valve", "ends", "joints", "supports", "pipeFinish"],
    groups: [
        { id: "run", label: "Run" },
        { id: "fittings", label: "Fittings" },
        { id: "supports", label: "Supports" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "layout", label: "Layout", type: "enum", default: "elbow", options: ["straight", "elbow", "tee", "riser", "loop"], optionLabels: ["Straight", "90° elbow", "Tee", "Riser offset", "Expansion loop"], group: "run" },
        { id: "length", label: "Length", type: "number", default: 3, min: 0.4, max: 12, unit: "m", group: "run" },
        { id: "diameter", label: "Diameter", type: "number", default: 0.11, min: 0.015, max: 0.6, unit: "m", decimals: 3, group: "run", description: "Outside diameter: everything else is sized from it." },
        { id: "wall", label: "Wall thickness", type: "number", default: 0.08, min: 0.04, max: 0.2, group: "run", description: "As a share of the diameter (visible at open ends)." },
        { id: "bendRadius", label: "Bend radius", type: "number", default: 1.5, min: 1, max: 5, group: "run", description: "Centre-line radius in diameters: 1.5 is a long-radius elbow." },
        { id: "rise", label: "Rise", type: "number", default: 1.2, min: 0.2, max: 4, unit: "m", group: "run", visibleIf: "=layout == 'riser'" },
        { id: "loopDepth", label: "Loop depth", type: "number", default: 1, min: 0.3, max: 3, unit: "m", group: "run", visibleIf: "=layout == 'loop'" },
        { id: "elevation", label: "Elevation", type: "number", default: 0.6, min: 0, max: 4, unit: "m", group: "supports", description: "Centre-line height of the run." },
        { id: "ends", label: "Ends", type: "enum", default: "flanged", options: ["open", "flanged", "capped"], optionLabels: ["Open", "Flanged", "Capped"], group: "fittings" },
        { id: "joints", label: "Joints", type: "enum", default: "flanged", options: ["none", "flanged", "couplings"], optionLabels: ["Welded", "Flanged", "Threaded couplings"], group: "fittings" },
        { id: "bolts", label: "Bolts", type: "int", default: 8, min: 4, max: 24, step: 4, group: "fittings", visibleIf: "=ends == 'flanged' || joints == 'flanged' || valve != 'none'" },
        { id: "valve", label: "Valve", type: "enum", default: "gate", options: ["none", "gate", "ball", "butterfly"], optionLabels: ["None", "Gate valve", "Ball valve", "Butterfly valve"], group: "fittings" },
        { id: "valveOpen", label: "Valve open", type: "number", default: 1, min: 0, max: 1, group: "fittings", visibleIf: "=valve == 'ball' || valve == 'butterfly'", description: "Turns the lever: along the pipe is open." },
        { id: "lagging", label: "Lagging", type: "bool", default: false, group: "fittings", description: "Insulation clad in sheet metal, stopping short of the fittings." },
        { id: "supports", label: "Supports", type: "enum", default: "stands", options: ["none", "stands", "hangers"], optionLabels: ["None", "Floor stands", "Ceiling hangers"], group: "supports" },
        { id: "spacing", label: "Support spacing", type: "number", default: 2, min: 0.6, max: 6, unit: "m", group: "supports", visibleIf: "=supports != 'none'" },
        { id: "pipeFinish", label: "Pipe", type: "material", default: "paint.signal", materials: ["metal", "paint", "plastic", "composite"], group: "materials" },
        { id: "valveFinish", label: "Valve body", type: "material", default: "paint.crimson", materials: ["paint", "metal"], group: "materials", visibleIf: "=valve != 'none'" },
        { id: "wheelFinish", label: "Handwheel", type: "material", default: "paint.black", materials: ["paint", "metal"], group: "materials", visibleIf: "=valve != 'none'" },
        { id: "lagFinish", label: "Cladding", type: "material", default: "metal.aluminum", materials: ["metal", "fabric.canvas", "canvas.white"], group: "materials", visibleIf: "=lagging" },
        { id: "supportFinish", label: "Supports", type: "material", default: "metal.zinc", materials: ["metal", "paint"], group: "materials", visibleIf: "=supports != 'none'" },
        { id: "seed", label: "Seed", type: "seed", default: 17, group: "materials", variation: 0 },
    ],
    derived: {
        R: "=diameter / 2",
        L: "=length",
        y: "=max(elevation, R * 2.2, fR + 0.01)",
        bend: "=bendRadius * diameter",
        bore: "=R * (1 - wall * 2)",
        // Flanges: about 1.8 diameters across on small pipe, a little less on large.
        fR: "=R + clamp(diameter * 0.45, 0.025, 0.12)",
        fT: "=clamp(diameter * 0.18, 0.008, 0.05)",
        boltR: "=(R + fR) / 2 + (fR - R) * 0.05",
        boltS: "=clamp((fR - R) * 0.18, 0.003, 0.02)",
        lagR: "=R + clamp(diameter * 0.35, 0.02, 0.08)",
        // Where the first straight run is, for the valve.
        vx: "=layout == 'straight' ? 0 : layout == 'riser' ? -L * 0.32 : layout == 'loop' ? -L * 0.38 : -L * 0.22",
        vLen: "=diameter * (valve == 'butterfly' ? 0.5 : 1.6)",
        hasValve: "=valve != 'none'",
        loopW: "=min(L * 0.18, loopDepth * 0.6)",
        // Open ends: the run's two end points and directions (+X or -X, or -Z for an elbow).
        endBx: "=layout == 'elbow' ? 0 : L / 2",
        endBz: "=layout == 'elbow' ? L / 2 : 0",
        endBy: "=layout == 'riser' ? y + rise : y",
        // The run's first straight leg, from its -X end to where it first bends.
        leg1: "=layout == 'straight' || layout == 'tee' ? L : layout == 'elbow' ? L / 2 - bend : layout == 'riser' ? L * 0.45 - bend : L / 2 - loopW - bend",
        lagStart: "=-L / 2 + fT + 0.03",
        lagEnd: "=hasValve ? vx - vLen / 2 - fT - 0.03 : -L / 2 + leg1 - fR",
        nJoints: "=joints == 'none' ? 0 : max(0, floor(L / 1.5) - 1)",
        nSupports: "=supports == 'none' ? 0 : max(1, floor(leg1 / spacing) + 1)",
    },
    rules: [
        { check: "=bend * 2.2 < L * (layout == 'loop' ? 0.36 : 0.5)", message: "The bends are too wide for so short a run." },
        { check: "=layout != 'riser' || rise > bend * 2.2", message: "The riser is shorter than its two bends." },
        { check: "=layout != 'loop' || loopDepth > bend * 2.2", message: "The loop is shallower than its bends." },
        { check: "=!hasValve || abs(vx) + vLen < L * 0.5 - bend", message: "The valve doesn't fit on the straight." },
        { check: "=supports != 'hangers' || y > 0.6", message: "Too low to hang from a ceiling." },
    ],
    regions: {
        pipe: { label: "Pipe", material: "=pipeFinish" },
        bore: { label: "Bore", material: "paint.black" },
        valve: { label: "Valve body", material: "=valveFinish" },
        wheel: { label: "Handwheel", material: "=wheelFinish" },
        bolts: { label: "Bolts", material: "metal.zinc" },
        lagging: { label: "Lagging", material: "=lagFinish" },
        support: { label: "Supports", material: "=supportFinish" },
    },
    presets: [
        { name: "Factory steam line", values: { layout: "loop", length: 8, diameter: 0.17, bendRadius: 1.5, loopDepth: 1.4, elevation: 1.0, ends: "flanged", joints: "flanged", bolts: 8, valve: "gate", lagging: true, supports: "stands", spacing: 2.5, pipeFinish: "metal.steel", valveFinish: "paint.crimson", wheelFinish: "paint.crimson", lagFinish: "metal.aluminum" } },
        { name: "Water main elbow", values: { layout: "elbow", length: 4, diameter: 0.3, bendRadius: 1.5, elevation: 0.5, ends: "flanged", joints: "flanged", bolts: 12, valve: "butterfly", valveOpen: 1, supports: "stands", spacing: 2, pipeFinish: "paint.navy", valveFinish: "paint.navy", wheelFinish: "paint.signal" } },
        { name: "Copper plumbing", values: { layout: "riser", length: 1.4, diameter: 0.022, wall: 0.06, bendRadius: 2, rise: 0.6, elevation: 0.3, ends: "open", joints: "couplings", valve: "ball", valveOpen: 0.3, supports: "none", pipeFinish: "metal.copper", valveFinish: "metal.brass", wheelFinish: "paint.crimson" } },
        { name: "Habitat utility tee", values: { layout: "tee", length: 2.5, diameter: 0.09, bendRadius: 1.5, elevation: 2.4, ends: "capped", joints: "flanged", bolts: 4, valve: "ball", valveOpen: 1, lagging: false, supports: "hangers", spacing: 1.2, pipeFinish: "composite.white", valveFinish: "paint.signal", wheelFinish: "paint.signal", supportFinish: "metal.titanium" } },
        { name: "Gas riser", values: { layout: "riser", length: 3, diameter: 0.06, bendRadius: 1.5, rise: 1.6, elevation: 0.25, ends: "capped", joints: "none", valve: "ball", valveOpen: 1, supports: "stands", spacing: 1.5, pipeFinish: "paint.signal", valveFinish: "paint.signal", wheelFinish: "paint.crimson" } },
    ],
    nodes: [
        // ===== The run: one swept tube with filleted bends ==========================================
        { id: "pathStraight", type: "path.points", output: false, points: [["=-L / 2", "=y", 0], ["=L / 2", "=y", 0]] },
        { id: "pathElbow", type: "path.points", output: false, fillet: "=bend", filletSegments: 12, points: [["=-L / 2", "=y", 0], [0, "=y", 0], [0, "=y", "=L / 2"]] },
        { id: "pathRiser", type: "path.points", output: false, fillet: "=bend", filletSegments: 12, points: [["=-L / 2", "=y", 0], ["=-L * 0.05", "=y", 0], ["=-L * 0.05", "=y + rise", 0], ["=L / 2", "=y + rise", 0]] },
        { id: "pathLoop", type: "path.points", output: false, fillet: "=bend", filletSegments: 10, points: [["=-L / 2", "=y", 0], ["=-loopW", "=y", 0], ["=-loopW", "=y", "=-loopDepth"], ["=loopW", "=y", "=-loopDepth"], ["=loopW", "=y", 0], ["=L / 2", "=y", 0]] },
        { id: "run", type: "mesh.sweep", path: { switch: "=layout", cases: { elbow: "@pathElbow", riser: "@pathRiser", loop: "@pathLoop" }, default: "@pathStraight" }, radius: "=R", sides: "=clamp(round(diameter * 200), 16, 40)", caps: true, region: "pipe" },
        // A tee's branch: a stub off the middle toward +Z, with a reinforcing collar.
        { id: "branch", type: "mesh.cylinder", when: "=layout == 'tee'", radius: "=R", height: "=L * 0.35", segments: "=clamp(round(diameter * 200), 16, 40)", rotate: [90, 0, 0], at: [0, "=y", 0], region: "pipe" },
        { id: "teeCollar", type: "mesh.sphere", when: "=layout == 'tee'", radius: "=R * 1.12", segments: 24, rings: 12, at: [0, "=y", 0], region: "pipe" },
        // ===== Ends ===================================================================================
        // Each end: a flange (or cap, or nothing) facing outward; the bore shows dark inside an open end.
        { id: "endFlange", type: "mesh.cylinder", output: false, when: "=ends == 'flanged'", radius: "=fR", height: "=fT", segments: 40, bevel: "=fT * 0.15", at: [0, "=-fT", 0], region: "pipe" },
        { id: "endBolts", type: "mesh.cylinder", output: false, when: "=ends == 'flanged'", repeat: "=bolts", radius: "=boltS", height: "=fT + boltS * 2.4", segments: 6, at: ["=cos(index * TAU / bolts) * boltR", "=-fT - boltS * 1.2", "=sin(index * TAU / bolts) * boltR"], region: "bolts" },
        { id: "endCap", type: "mesh.cylinder", output: false, when: "=ends == 'capped'", radius: "=R * 1.08", height: "=R * 0.5", segments: 32, bevel: "=R * 0.35", bevelSegments: 4, at: [0, "=-R * 0.3", 0], region: "pipe" },
        { id: "endBore", type: "mesh.cylinder", output: false, when: "=ends != 'capped'", radius: "=bore", height: 0.002, segments: 32, at: [0, 0.0005, 0], region: "bore" },
        { id: "endRim", type: "mesh.torus", output: false, when: "=ends == 'open'", major: "=(R + bore) / 2", minor: "=(R - bore) / 2", segments: 32, sides: 8, at: [0, -0.0005, 0], region: "pipe" },
        { id: "endUnit", type: "geo.join", output: false, meshes: ["@endFlange", "@endBolts", "@endCap", "@endBore", "@endRim"] },
        // Built facing +Y at the end point; stood to face along the run's end direction.
        { id: "endA", type: "geo.transform", mesh: "@endUnit", rotate: [0, 0, 90], at: ["=-L / 2", "=y", 0] },
        { id: "endB", type: "geo.transform", mesh: "@endUnit", rotate: ["=layout == 'elbow' ? 90 : 0", 0, "=layout == 'elbow' ? 0 : -90"], at: ["=endBx", "=endBy", "=endBz"] },
        { id: "endC", type: "geo.transform", when: "=layout == 'tee'", mesh: "@endUnit", rotate: [90, 0, 0], at: [0, "=y", "=L * 0.35"] },
        // ===== Joints along the first straight ======================================================
        { id: "jointFlanges", type: "mesh.cylinder", output: false, repeat: 2, radius: "=fR", height: "=fT", segments: 40, bevel: "=fT * 0.15", at: [0, "=index == 0 ? -fT - 0.001 : 0.001", 0], region: "pipe" },
        { id: "jointBolts", type: "mesh.cylinder", output: false, repeat: "=bolts", radius: "=boltS", height: "=fT * 2 + boltS * 2.4", segments: 6, at: ["=cos(index * TAU / bolts) * boltR", "=-fT - boltS * 1.2", "=sin(index * TAU / bolts) * boltR"], region: "bolts" },
        { id: "jointFlanged", type: "geo.join", output: false, meshes: ["@jointFlanges", "@jointBolts"] },
        { id: "coupling", type: "mesh.cylinder", output: false, radius: "=R * 1.18", height: "=diameter * 1.4", segments: 6, bevel: "=R * 0.06", at: [0, "=-diameter * 0.7", 0], region: "pipe" },
        {
            id: "joints", type: "geo.transform", when: "=joints != 'none'", repeat: "=nJoints",
            keep: "=(!hasValve || abs(-L / 2 + (index + 1) * 1.5 - vx) > vLen + fT * 3) && (index + 1) * 1.5 < leg1 - fR && (layout != 'tee' || abs(-L / 2 + (index + 1) * 1.5) > R * 2 + fR)",
            mesh: { if: "=joints == 'flanged'", then: "@jointFlanged", else: "@coupling" },
            rotate: [0, 0, 90],
            // Joints on the run's first leg only (straight up to where it bends).
            at: ["=-L / 2 + (index + 1) * 1.5", "=y", 0],
        },
        // ===== Valve ==================================================================================
        // Built along +Y through the origin (the pipe's axis), then laid along X at vx.
        { id: "valveFlanges", type: "mesh.cylinder", output: false, repeat: 2, radius: "=fR", height: "=fT", segments: 40, bevel: "=fT * 0.15", at: [0, "=index == 0 ? -vLen / 2 - fT : vLen / 2", 0], region: "valve" },
        { id: "valveBolts", type: "mesh.cylinder", output: false, repeat: "=bolts * 2", radius: "=boltS", height: "=fT + boltS * 2.4", segments: 6, at: ["=cos(index * TAU / bolts) * boltR", "=(index < bolts ? -vLen / 2 - fT : vLen / 2) - boltS * 1.2", "=sin(index * TAU / bolts) * boltR"], region: "bolts" },
        { id: "valveBulb", type: "mesh.sphere", output: false, when: "=valve != 'butterfly'", radius: "=R * 1.35", segments: 28, rings: 14, scale: [1, "=vLen / R / 2.7", 1], region: "valve" },
        { id: "valveWafer", type: "mesh.cylinder", output: false, when: "=valve == 'butterfly'", radius: "=fR * 0.96", height: "=vLen", segments: 40, at: [0, "=-vLen / 2", 0], region: "valve" },
        // Gate valve: a bonnet, a rising stem and a spoked handwheel above the pipe (+Z here becomes up).
        { id: "bonnet", type: "mesh.cylinder", output: false, when: "=valve == 'gate'", radius: "=R * 0.55", height: "=R * 1.6", segments: 20, bevel: "=R * 0.1", rotate: [90, 0, 0], at: [0, 0, "=R * 0.8"], region: "valve" },
        { id: "bonnetFlange", type: "mesh.cylinder", output: false, when: "=valve == 'gate'", radius: "=R * 0.85", height: "=R * 0.2", segments: 20, rotate: [90, 0, 0], at: [0, 0, "=R * 1.2"], region: "valve" },
        { id: "stem", type: "mesh.cylinder", output: false, when: "=valve == 'gate'", radius: "=R * 0.12", height: "=R * 1.3", segments: 10, rotate: [90, 0, 0], at: [0, 0, "=R * 2.3"], region: "bolts" },
        { id: "wheelRim", type: "mesh.torus", output: false, when: "=valve == 'gate'", major: "=R * 1.1", minor: "=R * 0.09", segments: 32, sides: 8, rotate: [90, 0, 0], at: [0, 0, "=R * 3.4"], region: "wheel" },
        { id: "wheelSpoke", type: "mesh.box", output: false, size: ["=R * 2.1", "=R * 0.1", "=R * 0.1"] },
        { id: "wheelSpokes", type: "instance.radial", output: false, when: "=valve == 'gate'", mesh: "@wheelSpoke", count: 3, rotate: [90, 0, 0], at: [0, 0, "=R * 3.4"], region: "wheel" },
        // Ball and butterfly valves: a lever on a short neck, turned by valveOpen.
        { id: "neck", type: "mesh.cylinder", output: false, when: "=valve == 'ball' || valve == 'butterfly'", radius: "=R * 0.3", height: "=valve == 'butterfly' ? fR - R * 0.6 + R * 0.4 : R * 0.9", segments: 12, rotate: [90, 0, 0], at: [0, 0, "=R * 0.6"], region: "valve" },
        { id: "leverBar", type: "mesh.box", output: false, size: ["=max(diameter * 2.4, 0.08)", "=max(R * 0.3, 0.008)", "=max(R * 0.12, 0.004)"], radius: "=max(R * 0.05, 0.002)", at: ["=max(diameter * 2.4, 0.08) / 2 - R * 0.3", 0, 0] },
        { id: "lever", type: "geo.transform", output: false, when: "=valve == 'ball' || valve == 'butterfly'", mesh: "@leverBar", rotate: [0, "=valveOpen * 90", 0], at: [0, 0, 0] },
        { id: "leverPlaced", type: "geo.transform", output: false, mesh: "@lever", rotate: [-90, 0, 0], at: [0, 0, "=valve == 'butterfly' ? fR + R * 0.45 : R * 1.55"], region: "wheel" },
        { id: "valveUnit", type: "geo.join", output: false, meshes: ["@valveFlanges", "@valveBolts", "@valveBulb", "@valveWafer", "@bonnet", "@bonnetFlange", "@stem", "@wheelRim", "@wheelSpokes", "@neck", "@leverPlaced"] },
        // Laid along X: +Y (the axis) becomes -X and +Z (up the stem) becomes +Y.
        { id: "valvePlaced", type: "geo.transform", when: "=hasValve", mesh: "@valveUnit", rotate: [-90, 90, 0], at: ["=vx", "=y", 0] },
        // ===== Lagging: a clad jacket on the first straight leg, short of the fittings ===============
        { id: "lag", type: "mesh.cylinder", when: "=lagging && lagEnd - lagStart > 0.1", radius: "=lagR", height: "=lagEnd - lagStart", segments: 32, bevel: "=(lagR - R) * 0.4", rotate: [0, 0, -90], at: ["=lagStart", "=y", 0], region: "lagging" },
        { id: "lagBands", type: "mesh.cylinder", when: "=lagging && lagEnd - lagStart > 0.6", repeat: "=floor((lagEnd - lagStart) / 0.6)", radius: "=lagR + 0.002", height: 0.02, segments: 32, rotate: [0, 0, -90], at: ["=lagStart + 0.3 + index * 0.6", "=y", 0], region: "bolts" },
        // ===== Supports along the first leg ===========================================================
        { id: "stands", type: "mesh.box", when: "=supports == 'stands' && y - (lagging ? lagR : R) > 0.05", repeat: "=nSupports", size: ["=clamp(diameter * 0.5, 0.04, 0.12)", "=y - (lagging ? lagR : R)", "=clamp(diameter * 0.5, 0.04, 0.12)"], at: ["=-L / 2 + (index + 0.5) * leg1 / count", "=(y - (lagging ? lagR : R)) / 2", 0], region: "support" },
        { id: "standFeet", type: "mesh.box", when: "=supports == 'stands' && y - (lagging ? lagR : R) > 0.05", repeat: "=nSupports", size: ["=clamp(diameter * 1.4, 0.1, 0.4)", 0.015, "=clamp(diameter * 1.4, 0.1, 0.4)"], at: ["=-L / 2 + (index + 0.5) * leg1 / count", 0.0075, 0], region: "support" },
        { id: "saddles", type: "mesh.torus", when: "=supports != 'none'", repeat: "=nSupports", major: "=(lagging ? lagR : R) + 0.006", minor: "=clamp(diameter * 0.06, 0.004, 0.015)", segments: 32, sides: 8, rotate: [0, 0, 90], at: ["=-L / 2 + (index + 0.5) * leg1 / count", "=y", 0], region: "support" },
        { id: "hangerRods", type: "mesh.cylinder", when: "=supports == 'hangers'", repeat: "=nSupports", radius: "=clamp(diameter * 0.08, 0.005, 0.016)", height: 0.6, segments: 8, at: ["=-L / 2 + (index + 0.5) * leg1 / count", "=y + (lagging ? lagR : R)", 0], region: "support" },
    ],
    limits: { maxSize: 14, minSize: 0.1, maxTriangles: 120000 },
};

export default pipe;
