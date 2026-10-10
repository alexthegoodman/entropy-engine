import type { NodeDef, ObjectDef } from "../mesha_object";

// One bay of infill between two posts, `w` wide, built from x = 0 (the left post's face) along +X,
// standing on y = 0, centred on z = 0. The same recipe builds every panel and the gate's leaf, so a
// gate always matches its fence. Every node is an intermediate; `${p}Unit` joins them.
function infill(p: string, w: string, h: string): NodeDef[] {
    const n = (node: NodeDef): NodeDef => ({ ...node, id: `${p}${node.id}`, output: false });
    const picketN = `max(1, floor((${w} + gapW) / (boardW + gapW)))`;
    const picketPitch = `(${w} / ${picketN})`;
    const barN = `max(1, floor(${w} / barPitch))`;
    return [
        // Rails behind pickets and boards; a picket or board fence hangs them on these.
        n({ id: "Rails", type: "mesh.box", when: "=infillStyle == 'picket' || infillStyle == 'boards'", repeat: 2, size: [`=${w}`, "=railH", "=railT"], radius: 0.003, at: [`=${w} / 2`, `=index == 0 ? ${h} * 0.2 : ${h} * 0.72`, "=-railT / 2 - boardT / 2"], region: "frame" }),
        // Pickets: a board with a pointed, round or square top.
        n({ id: "PicketBody", type: "mesh.box", size: ["=boardW", `=${h} - 0.05 - tipH`, "=boardT"], radius: 0.002, at: [0, `=(${h} - 0.05 - tipH) / 2 + 0.05`, 0] }),
        n({ id: "TipPointOutline", type: "curve.points", closed: true, points: [["=-boardW / 2", 0], ["=boardW / 2", 0], [0, "=tipH"]] }),
        n({ id: "TipRound", type: "curve.circle", radius: "=boardW / 2", segments: 16 }),
        n({ id: "Tip", type: "mesh.extrude", when: "=picketTop != 'flat'", outline: { switch: "=picketTop", cases: { pointed: "@" + p + "TipPointOutline", round: "@" + p + "TipRound" }, default: "@" + p + "TipPointOutline" }, height: "=boardT", rotate: [-90, 0, 0], at: [0, `=${h} - tipH`, "=boardT / 2"] }),
        n({ id: "Picket", type: "geo.join", meshes: ["@" + p + "PicketBody", "@" + p + "Tip"] }),
        n({ id: "Pickets", type: "geo.transform", when: "=infillStyle == 'picket'", repeat: `=${picketN}`, mesh: "@" + p + "Picket", at: [`=(index + 0.5) * ${picketPitch}`, 0, 0], region: "infill" }),
        // Close boards: a privacy fence with a capping rail.
        n({ id: "Boards", type: "mesh.box", when: "=infillStyle == 'boards'", repeat: `=max(1, floor(${w} / (boardW + 0.006)))`, size: [`=${w} / max(1, floor(${w} / (boardW + 0.006))) - 0.006`, `=${h} - 0.06`, "=boardT"], radius: 0.002, at: [`=(index + 0.5) * ${w} / count`, `=(${h} - 0.06) / 2 + 0.03`, 0], region: "infill" }),
        n({ id: "Cap", type: "mesh.box", when: "=infillStyle == 'boards'", size: [`=${w} + 0.01`, 0.025, "=boardT + railT + 0.03"], radius: 0.004, at: [`=${w} / 2`, `=${h} - 0.018`, "=-railT / 2"], region: "frame" }),
        // Post and rail: deep horizontal rails, or round ones.
        n({ id: "RanchRails", type: "mesh.box", when: "=infillStyle == 'rails'", repeat: "=rails", size: [`=${w} + 0.02`, 0.11, 0.04], radius: 0.006, at: [`=${w} / 2`, `=${h} - 0.1 - index * (${h} - 0.3) / max(rails - 1, 1)`, 0], region: "infill" }),
        // Ironwork: flat top and bottom rails, round bars and spear finials.
        n({ id: "IronRails", type: "mesh.box", when: "=infillStyle == 'iron'", repeat: 3, size: [`=${w}`, 0.03, 0.016], at: [`=${w} / 2`, `=[0.1, ${h} - 0.14, ${h} - 0.28][index]`, 0], region: "frame" }),
        n({ id: "Bars", type: "mesh.cylinder", when: "=infillStyle == 'iron'", repeat: `=${barN}`, radius: "=barR", height: `=${h} - 0.06`, segments: 10, at: [`=(index + 0.5) * ${w} / ${barN}`, 0.06, 0], region: "infill" }),
        n({ id: "Spears", type: "mesh.cone", when: "=infillStyle == 'iron' && finials", repeat: `=${barN}`, bottomRadius: "=barR * 2.2", topRadius: 0, height: 0.07, segments: 4, rotate: [0, 45, 0], at: [`=(index + 0.5) * ${w} / ${barN}`, `=${h}`, 0], region: "infill" }),
        n({ id: "Rings", type: "mesh.torus", when: "=infillStyle == 'iron' && finials", repeat: `=max(0, ${barN} - 1)`, major: 0.045, minor: "=barR * 0.7", segments: 18, sides: 6, rotate: [90, 0, 0], at: [`=(index + 1) * ${w} / ${barN}`, `=${h} - 0.21`, 0], region: "infill" }),
        // Glass balustrade: a bottom shoe, clamped glass and a round handrail.
        n({ id: "Shoe", type: "mesh.box", when: "=infillStyle == 'glass'", size: [`=${w}`, 0.06, 0.05], radius: 0.004, at: [`=${w} / 2`, 0.03, 0], region: "frame" }),
        n({ id: "Glass", type: "mesh.box", when: "=infillStyle == 'glass'", size: [`=${w} - 0.03`, `=${h} - 0.13`, 0.012], at: [`=${w} / 2`, `=(${h} - 0.13) / 2 + 0.06`, 0], region: "glass" }),
        n({ id: "Handrail", type: "mesh.cylinder", when: "=infillStyle == 'glass'", radius: 0.022, height: `=${w} + 0.02`, segments: 18, rotate: [0, 0, -90], at: [-0.01, `=${h} - 0.022`, 0], region: "frame" }),
        { id: `${p}Unit`, type: "geo.join", output: false, meshes: ["Rails", "Pickets", "Boards", "Cap", "RanchRails", "IronRails", "Bars", "Spears", "Rings", "Shoe", "Glass", "Handrail"].map(k => "@" + p + k) },
    ];
}

/**
 * A straight run of fence, railing or balustrade: posts with caps or finials, and pickets, close
 * boards, ranch rails, ironwork or glass between them, with an optional gate in one bay that swings
 * out on hinges (strap hinges on timber, butt hinges on metal) and clears its posts. Runs along X,
 * faces +Z; the run's middle is at the origin.
 */
const fence: ObjectDef = {
    id: "architecture.fence",
    name: "Fence, Gate & Railing",
    category: "Architecture",
    tags: ["fence", "picket fence", "gate", "railing", "balustrade", "garden fence", "privacy fence", "iron fence", "balcony", "post and rail", "ranch fence"],
    description: "Picket, board, ranch, iron and glass fences and railings, with a swinging gate.",
    featured: ["length", "height", "postSpacing", "infillStyle", "gate", "gateOpen", "infillFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "infill", label: "Infill" },
        { id: "posts", label: "Posts" },
        { id: "gate", label: "Gate" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "length", label: "Length", type: "number", default: 6, min: 1, max: 20, unit: "m", group: "size" },
        { id: "height", label: "Height", type: "number", default: 1.1, min: 0.4, max: 2.2, unit: "m", group: "size" },
        { id: "postSpacing", label: "Post spacing", type: "number", default: 2, min: 0.8, max: 3, unit: "m", group: "size" },
        { id: "infillStyle", label: "Infill", type: "enum", default: "picket", options: ["picket", "boards", "rails", "iron", "glass"], optionLabels: ["Pickets", "Close boards", "Ranch rails", "Ironwork", "Glass"], group: "infill" },
        { id: "boardWidth", label: "Board width", type: "number", default: 0.075, min: 0.04, max: 0.18, unit: "m", decimals: 3, group: "infill", visibleIf: "=infillStyle == 'picket' || infillStyle == 'boards'" },
        { id: "gap", label: "Gap", type: "number", default: 0.06, min: 0.01, max: 0.15, unit: "m", decimals: 3, group: "infill", visibleIf: "=infillStyle == 'picket'" },
        { id: "picketTop", label: "Picket top", type: "enum", default: "pointed", options: ["pointed", "round", "flat"], optionLabels: ["Pointed", "Round", "Square"], group: "infill", visibleIf: "=infillStyle == 'picket'" },
        { id: "rails", label: "Rails", type: "int", default: 3, min: 2, max: 5, group: "infill", visibleIf: "=infillStyle == 'rails'" },
        { id: "barPitch", label: "Bar spacing", type: "number", default: 0.12, min: 0.08, max: 0.25, unit: "m", decimals: 3, group: "infill", visibleIf: "=infillStyle == 'iron'" },
        { id: "finials", label: "Finials and rings", type: "bool", default: true, group: "infill", visibleIf: "=infillStyle == 'iron'" },
        { id: "postStyle", label: "Post", type: "enum", default: "capped", options: ["capped", "ball", "plain"], optionLabels: ["Pyramid cap", "Ball finial", "Plain"], group: "posts" },
        { id: "postSize", label: "Post size", type: "number", default: 0.09, min: 0.04, max: 0.2, unit: "m", decimals: 3, group: "posts" },
        { id: "postRise", label: "Post rise", type: "number", default: 0.08, min: 0, max: 0.3, unit: "m", group: "posts", description: "How far posts stand above the infill." },
        { id: "gate", label: "Gate", type: "bool", default: true, group: "gate" },
        { id: "gateBay", label: "Gate bay", type: "int", default: 1, min: 0, max: "=max(0, bays - 1)", group: "gate", visibleIf: "=gate" },
        { id: "gateOpen", label: "Open", type: "number", default: 35, min: 0, max: 110, unit: "°", group: "gate", visibleIf: "=gate" },
        { id: "infillFinish", label: "Infill", type: "material", default: "paint.white", materials: ["wood", "paint", "metal.black", "metal.steel", "metal.rust", "metal.aluminum"], group: "materials" },
        { id: "frameFinish", label: "Posts and rails", type: "material", default: "paint.white", materials: ["wood", "paint", "metal.black", "metal.steel", "metal.rust", "metal.aluminum", "stone", "masonry"], group: "materials" },
        { id: "glassFinish", label: "Glass", type: "material", default: "glass.window", materials: ["glass.window", "glass.windowTinted", "glass.frosted"], group: "materials", visibleIf: "=infillStyle == 'glass'" },
        { id: "seed", label: "Seed", type: "seed", default: 8, group: "materials", variation: 0 },
    ],
    derived: {
        bays: "=max(1, round(length / postSpacing))",
        span: "=length / bays",
        ps: "=postSize",
        w: "=span - ps",
        h: "=height",
        boardW: "=boardWidth",
        boardT: "=infillStyle == 'boards' ? 0.02 : 0.018",
        gapW: "=gap",
        tipH: "=picketTop == 'pointed' ? boardW * 0.6 : picketTop == 'round' ? boardW / 2 : 0",
        railH: 0.07,
        railT: 0.03,
        barR: 0.008,
        postH: "=height + postRise",
        hasGate: "=gate && bays >= 1",
        gg: 0.012,
        // The leaf is its bay less a clearance at the hinge and latch, a little off the ground.
        gw: "=w - 2 * gg",
        gh: "=height - 0.04",
        timber: "=infillStyle == 'picket' || infillStyle == 'boards' || infillStyle == 'rails'",
    },
    rules: [
        { check: "=w >= 0.5", message: "The posts crowd together: space them wider or make them slimmer." },
        { check: "=!hasGate || gw >= 0.6", message: "The gate bay is too narrow to walk through." },
        { check: "=!hasGate || gw <= 2.2", message: "A gate leaf that wide would sag: closer posts." },
        { check: "=infillStyle != 'picket' || tipH < height * 0.25", message: "The picket tips are taller than the pickets." },
    ],
    regions: {
        frame: { label: "Posts and rails", material: "=frameFinish" },
        infill: { label: "Infill", material: "=infillFinish" },
        glass: { label: "Glass", material: "=glassFinish" },
        hardware: { label: "Hardware", material: "metal.black" },
    },
    presets: [
        { name: "White picket", values: { length: 6, height: 1.0, postSpacing: 2, infillStyle: "picket", boardWidth: 0.075, gap: 0.06, picketTop: "pointed", postStyle: "capped", postSize: 0.09, postRise: 0.1, gate: true, gateBay: 1, gateOpen: 35, infillFinish: "paint.white", frameFinish: "paint.white" } },
        { name: "Cedar privacy", values: { length: 7.2, height: 1.8, postSpacing: 1.8, infillStyle: "boards", boardWidth: 0.14, postStyle: "capped", postSize: 0.1, postRise: 0.04, gate: true, gateBay: 0, gateOpen: 0, infillFinish: "wood.weathered", frameFinish: "wood.weathered" } },
        { name: "Ranch rail", values: { length: 12, height: 1.3, postSpacing: 3, infillStyle: "rails", rails: 3, postStyle: "plain", postSize: 0.14, postRise: 0.05, gate: false, infillFinish: "wood.ash", frameFinish: "wood.ash" } },
        { name: "Wrought iron", values: { length: 6, height: 1.5, postSpacing: 2, infillStyle: "iron", barPitch: 0.11, finials: true, postStyle: "ball", postSize: 0.07, postRise: 0.12, gate: true, gateBay: 1, gateOpen: 60, infillFinish: "metal.black", frameFinish: "metal.black" } },
        { name: "Glass balcony guard", values: { length: 4, height: 1.05, postSpacing: 1.3, infillStyle: "glass", postStyle: "plain", postSize: 0.05, postRise: 0, gate: false, infillFinish: "metal.steel", frameFinish: "metal.steel", glassFinish: "glass.window" } },
        { name: "Garden picket, round tops", values: { length: 4, height: 0.8, postSpacing: 1.33, infillStyle: "picket", boardWidth: 0.09, gap: 0.035, picketTop: "round", postStyle: "ball", postSize: 0.08, postRise: 0.12, gate: true, gateBay: 1, gateOpen: 80, infillFinish: "paint.sage", frameFinish: "paint.sage" } },
    ],
    nodes: [
        // Posts with caps or ball finials.
        { id: "posts", type: "mesh.box", repeat: "=bays + 1", size: ["=ps", "=postH", "=ps"], radius: "=min(0.006, ps * 0.08)", at: ["=-length / 2 + index * span", "=postH / 2", 0], region: "frame" },
        { id: "caps", type: "mesh.cone", when: "=postStyle == 'capped'", repeat: "=bays + 1", bottomRadius: "=ps * 0.78", topRadius: 0, height: "=ps * 0.35", segments: 4, rotate: [0, 45, 0], at: ["=-length / 2 + index * span", "=postH + 0.015", 0], region: "frame" },
        { id: "capPlates", type: "mesh.box", when: "=postStyle == 'capped'", repeat: "=bays + 1", size: ["=ps * 1.12", 0.015, "=ps * 1.12"], radius: 0.002, at: ["=-length / 2 + index * span", "=postH + 0.0075", 0], region: "frame" },
        { id: "balls", type: "mesh.sphere", when: "=postStyle == 'ball'", repeat: "=bays + 1", radius: "=ps * 0.55", segments: 18, rings: 10, at: ["=-length / 2 + index * span", "=postH + ps * 0.62", 0], region: "frame" },
        { id: "ballNecks", type: "mesh.cylinder", when: "=postStyle == 'ball'", repeat: "=bays + 1", radius: "=ps * 0.25", height: "=ps * 0.2", segments: 12, at: ["=-length / 2 + index * span", "=postH", 0], region: "frame" },
        // Every bay but the gate's.
        ...infill("panel", "w", "h"),
        { id: "panels", type: "geo.transform", repeat: "=bays", keep: "=!hasGate || index != gateBay", mesh: "@panelUnit", at: ["=-length / 2 + index * span + ps / 2", 0, 0] },
        // The gate: the same infill on a framed leaf with a diagonal brace (timber), on two hinges.
        ...infill("leaf", "gw", "gh"),
        { id: "leafStiles", type: "mesh.box", output: false, when: "=infillStyle != 'glass'", repeat: 2, size: [0.045, "=gh - 0.06", "=timber ? 0.035 : 0.02"], radius: 0.003, at: ["=index == 0 ? 0.0225 : gw - 0.0225", "=(gh - 0.06) / 2 + 0.05", "=timber ? -boardT / 2 - 0.0175 : 0"], region: "frame" },
        { id: "leafBrace", type: "mesh.box", output: false, when: "=timber", size: ["=hypot(gw - 0.09, gh * 0.52) ", "=railH", "=railT"], radius: 0.003, rotate: [0, 0, "=deg(atan2(gh * 0.52, gw - 0.09))"], at: ["=gw / 2", "=gh * 0.46", "=-railT / 2 - boardT / 2"], region: "frame" },
        { id: "latch", type: "mesh.box", output: false, size: [0.06, 0.03, 0.02], radius: 0.004, at: ["=gw - 0.02", "=gh * 0.75", "=timber ? boardT / 2 + 0.012 : 0.02"], region: "hardware" },
        {
            id: "leafHinges", type: "object", object: "component.hinge", output: false, repeat: 2, region: "hardware",
            params: { style: "=timber ? 'strap' : 'butt'", height: "=timber ? 0.05 : 0.08", leafWidth: "=timber ? min(gw * 0.45, 0.4) : 0.03", knuckles: 3, open: 180 },
            at: [0, "=index == 0 ? gh * 0.2 + 0.03 : gh * 0.72 + 0.03", "=timber ? boardT / 2 + 0.006 : 0"],
        },
        { id: "leaf", type: "geo.join", output: false, meshes: ["@leafUnit", "@leafStiles", "@leafBrace", "@latch", "@leafHinges"] },
        // Hinged at the left post's face, swinging out toward +Z.
        { id: "gateLeaf", type: "geo.transform", when: "=hasGate", mesh: "@leaf", rotate: [0, "=-gateOpen", 0], at: ["=-length / 2 + gateBay * span + ps / 2 + gg", 0.04, 0] },
    ],
    limits: { maxSize: 21, minSize: 0.8, maxTriangles: 200000 },
};

export default fence;
