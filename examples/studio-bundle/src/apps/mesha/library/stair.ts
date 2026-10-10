import type { NodeDef, ObjectDef } from "../mesha_object";

// One flight of `nf` risers rising from a floor at `y0`, built from its first riser's face at z = 0
// up toward -Z, x across its width. It has nf - 1 treads: the last riser steps onto whatever the
// flight arrives at (a landing, or the floor above). `${p}Unit` joins it.
function flight(p: string, nf: string, y0: string): NodeDef[] {
    const n = (node: NodeDef): NodeDef => ({ ...node, id: `${p}${node.id}`, output: false });
    // The handrail's height above the pitch line, at depth z (z <= 0) along the flight.
    const railY = (z: string) => `(${y0} + rise1 + railH + (-(${z}) / going) * rise1)`;
    const side = "(railSide == 'both' ? index * 2 - 1 : railSide == 'left' ? -1 : 1)";
    const sides = "(railSide == 'both' ? 2 : railSide == 'none' ? 0 : 1)";
    const run = `((${nf} - 1) * going)`;
    return [
        n({ id: "Treads", type: "mesh.box", repeat: `=${nf} - 1`, size: ["=width", "=tt", "=going + nose"], radius: "=min(0.008, tt * 0.3)", at: [0, `=${y0} + (index + 1) * rise1 - tt / 2`, "=-index * going - going / 2 + nose / 2"], region: "treads" }),
        n({ id: "Risers", type: "mesh.box", when: "=style == 'closed'", repeat: `=${nf}`, size: ["=width", "=rise1 - tt", 0.02], at: [0, `=${y0} + index * rise1 + (rise1 - tt) / 2`, "=-index * going - 0.01"], region: "structure" }),
        n({ id: "Blocks", type: "mesh.box", when: "=style == 'solid'", repeat: `=${nf} - 1`, size: ["=width", `=${y0} + (index + 1) * rise1 - tt`, "=going"], at: [0, `=(${y0} + (index + 1) * rise1 - tt) / 2`, "=-index * going - going / 2"], region: "structure" }),
        // Stringers along the pitch, cut level at the floor and at the landing.
        n({
            id: "StringerBars", type: "mesh.box", when: "=style == 'closed' || style == 'open' || style == 'spine'", repeat: "=style == 'spine' ? 1 : 2",
            size: ["=style == 'spine' ? 0.14 : stringerT", "=stringerH", `=(${run} + (style == 'closed' ? 0 : going * 0.6)) / cos(ang) + stringerH * tan(ang) + 0.02`], radius: 0.004,
            rotate: ["=deg(ang)", 0, 0],
            // Closed strings stand proud of the nosings; open stringers run under the treads' back edges.
            at: [
                "=style == 'spine' ? 0 : (index * 2 - 1) * (style == 'closed' ? width / 2 + stringerT / 2 : width / 2 - 0.12)",
                `=${y0} + (style == 'closed' ? rise1 + 0.05 : -tt) + ((${run} + (style == 'closed' ? 0 : going * 0.6)) / 2 / going) * rise1 - stringerH / 2 / cos(ang)`,
                `=-(${run} + (style == 'closed' ? 0 : going * 0.6)) / 2`,
            ],
        }),
        n({ id: "StringersCut", type: "deform.clamp", when: "=style == 'closed' || style == 'open' || style == 'spine'", mesh: `@${p}StringerBars`, min: `=${y0}`, max: `=${y0} + ${nf} * rise1 + (style == 'closed' ? 0.06 : -tt)`, give: 0.01 }),
        n({ id: "Stringers", type: "geo.smooth", when: "=style == 'closed' || style == 'open' || style == 'spine'", mesh: `@${p}StringersCut`, smooth: true, angle: 35, region: "structure" }),
        // Handrails on the chosen sides, carried by balusters (two a tread), glass or a newel.
        n({ id: "Handrail", type: "mesh.cylinder", when: "=railSide != 'none'", repeat: `=${sides}`, radius: 0.025, height: `=${run} / cos(ang) + 0.1`, segments: 16, rotate: ["=deg(ang) - 90", 0, 0], at: [`=${side} * (width / 2 - 0.035)`, `=${railY("0.05 * cos(ang)")} - 0.05 * sin(ang)`, "=0.05 * cos(ang)"], region: "rails" }),
        n({
            id: "Balusters", type: "mesh.cylinder", when: "=railSide != 'none' && (balusters == 'spindles' || balusters == 'bars')", repeat: `=${sides} * (${nf} - 1) * 2`,
            radius: "=balusters == 'bars' ? 0.008 : 0.016", segments: 10,
            height: `=${railY(`-(floor((index % ((${nf} - 1) * 2)) / 2) + (index % 2) * 0.5 + 0.25) * going`)} - (${y0} + (floor((index % ((${nf} - 1) * 2)) / 2) + 1) * rise1) - 0.02`,
            at: [
                `=(railSide == 'both' ? floor(index / ((${nf} - 1) * 2)) * 2 - 1 : railSide == 'left' ? -1 : 1) * (width / 2 - 0.035)`,
                `=${y0} + (floor((index % ((${nf} - 1) * 2)) / 2) + 1) * rise1`,
                `=-(floor((index % ((${nf} - 1) * 2)) / 2) + (index % 2) * 0.5 + 0.25) * going`,
            ],
            region: "balusters",
        }),
        n({ id: "Glass", type: "mesh.box", when: "=railSide != 'none' && balusters == 'glass'", repeat: `=${sides}`, size: [0.012, "=railH - 0.12", `=${run} / cos(ang)`], rotate: ["=deg(ang)", 0, 0], at: [`=${side} * (width / 2 - 0.035)`, `=${railY(`-${run} / 2`)} - railH / 2 - 0.0`, `=-${run} / 2`], region: "glass" }),
        n({ id: "Newels", type: "mesh.box", when: "=railSide != 'none' && balusters != 'glass'", repeat: `=${sides}`, size: [0.08, `=rise1 + railH + 0.08`, 0.08], radius: 0.006, at: [`=${side} * (width / 2 - 0.035)`, `=${y0} + (rise1 + railH + 0.08) / 2`, 0.03], region: "rails" }),
        { id: `${p}Unit`, type: "geo.join", output: false, meshes: ["Treads", "Risers", "Blocks", "Stringers", "Handrail", "Balusters", "Glass", "Newels"].map(k => `@${p}${k}`) },
    ];
}

/**
 * A stair from a porch step to a two-flight interior stair, or an accessible ramp. Risers divide the
 * rise evenly at the target riser height; treads have nosings; flights are closed (strings and
 * risers), open (treads on stringers), on a central steel spine, or solid masonry down to the ground.
 * Two flights meet at a landing, straight on or turning left or right; a top landing is optional.
 * Ramps climb at the chosen gradient with a level rest landing every 0.75 m of rise. The first
 * riser faces +Z at z = 0 and the stair climbs toward -Z.
 */
const stair: ObjectDef = {
    id: "architecture.stair",
    name: "Stair, Ramp & Landing",
    category: "Architecture",
    tags: ["stairs", "staircase", "steps", "stair", "porch steps", "flight", "landing", "ramp", "access ramp", "handrail", "balustrade"],
    description: "Straight, landing and L-shaped stairs and accessible ramps, with handrails.",
    featured: ["rise", "width", "type", "style", "riserTarget", "going", "railSide", "balusters", "treadFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "layout", label: "Layout" },
        { id: "build", label: "Construction" },
        { id: "rails", label: "Rails" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "rise", label: "Total rise", type: "number", default: 1.4, min: 0.3, max: 4, unit: "m", group: "size" },
        { id: "width", label: "Width", type: "number", default: 1.0, min: 0.6, max: 3, unit: "m", group: "size" },
        { id: "type", label: "Layout", type: "enum", default: "straight", options: ["straight", "landing", "lLeft", "lRight", "ramp"], optionLabels: ["Straight flight", "Two flights, straight", "Turn left at landing", "Turn right at landing", "Ramp"], group: "layout" },
        { id: "riserTarget", label: "Riser height", type: "number", default: 0.175, min: 0.12, max: 0.22, unit: "m", decimals: 3, group: "layout", visibleIf: "=type != 'ramp'", description: "The target; the rise is divided into equal risers near it." },
        { id: "going", label: "Tread depth", type: "number", default: 0.27, min: 0.2, max: 0.4, unit: "m", decimals: 3, group: "layout", visibleIf: "=type != 'ramp'" },
        { id: "landingDepth", label: "Landing depth", type: "number", default: 1.0, min: 0.8, max: 2.5, unit: "m", group: "layout", visibleIf: "=type == 'landing' || topLanding || type == 'ramp'" },
        { id: "topLanding", label: "Top landing", type: "bool", default: false, group: "layout" },
        { id: "gradient", label: "Ramp gradient", type: "number", default: 7, min: 4, max: 12, unit: "%", group: "layout", visibleIf: "=type == 'ramp'" },
        { id: "style", label: "Construction", type: "enum", default: "closed", options: ["closed", "open", "spine", "solid"], optionLabels: ["Closed strings and risers", "Open treads", "Steel spine", "Solid masonry"], group: "build", visibleIf: "=type != 'ramp'" },
        { id: "treadThickness", label: "Tread thickness", type: "number", default: 0.04, min: 0.02, max: 0.08, unit: "m", decimals: 3, group: "build", visibleIf: "=type != 'ramp'" },
        { id: "nosing", label: "Nosing", type: "number", default: 0.025, min: 0, max: 0.04, unit: "m", decimals: 3, group: "build", visibleIf: "=type != 'ramp'" },
        { id: "railSide", label: "Handrail", type: "enum", default: "both", options: ["none", "left", "right", "both"], optionLabels: ["None", "Left", "Right", "Both sides"], group: "rails" },
        { id: "railHeight", label: "Rail height", type: "number", default: 0.9, min: 0.75, max: 1.1, unit: "m", group: "rails", visibleIf: "=railSide != 'none'" },
        { id: "balusters", label: "Balusters", type: "enum", default: "spindles", options: ["spindles", "bars", "glass", "none"], optionLabels: ["Spindles", "Steel bars", "Glass", "Handrail only"], group: "rails", visibleIf: "=railSide != 'none'" },
        { id: "treadFinish", label: "Treads", type: "material", default: "wood.oak", materials: ["wood", "stone", "masonry.concrete", "masonry.brick", "metal.steel", "metal.black", "rubber.floor"], group: "materials" },
        { id: "structureFinish", label: "Structure", type: "material", default: "paint.white", materials: ["wood", "paint", "metal", "masonry", "stone"], group: "materials" },
        { id: "railFinish", label: "Rails", type: "material", default: "wood.walnut", materials: ["wood", "paint", "metal"], group: "materials", visibleIf: "=railSide != 'none'" },
        { id: "balusterFinish", label: "Balusters", type: "material", default: "paint.white", materials: ["wood", "paint", "metal"], group: "materials", visibleIf: "=railSide != 'none' && (balusters == 'spindles' || balusters == 'bars')" },
        { id: "seed", label: "Seed", type: "seed", default: 13, group: "materials", variation: 0 },
    ],
    derived: {
        isRamp: "=type == 'ramp'",
        nRisers: "=max(2, round(rise / riserTarget))",
        rise1: "=rise / nRisers",
        ang: "=atan2(rise1, going)",
        tt: "=treadThickness",
        nose: "=nosing",
        railH: "=railHeight",
        stringerT: 0.04,
        stringerH: "=clamp(rise1 + going * 0.35, 0.2, 0.35)",
        twoFlights: "=type != 'straight' && type != 'ramp'",
        n1: "=twoFlights ? ceil(nRisers / 2) : nRisers",
        n2: "=twoFlights ? nRisers - n1 : 0",
        h1: "=n1 * rise1",
        run1: "=(n1 - 1) * going",
        run2: "=(n2 - 1) * going",
        turn: "=type == 'lLeft' ? -1 : type == 'lRight' ? 1 : 0",
        // A straight landing is landingDepth deep; a turning one is as deep as the stair is wide.
        midD: "=type == 'landing' ? landingDepth : width",
        midZ: "=-run1 - midD / 2",
        // Where the second flight starts and where the stair arrives.
        f2x: "=turn * width / 2",
        f2z: "=type == 'landing' ? -run1 - midD : midZ",
        topX: "=turn == 0 ? 0 : turn * (width / 2 + run2)",
        topZ: "=twoFlights ? (turn == 0 ? f2z - run2 : midZ) : -run1",
        // Ramp: segments of at most 0.75 m rise, each followed by a level landing.
        segs: "=max(1, ceil(rise / 0.75))",
        segRise: "=rise / segs",
        segLen: "=segRise / (gradient / 100)",
        restL: 1.5,
        rampA: "=atan2(gradient, 100)",
        postW: 0.09,
    },
    rules: [
        { check: "=isRamp || (2 * rise1 + going >= 0.55 && 2 * rise1 + going <= 0.72)", message: "Steps this shape are awkward to climb: two risers and a tread should make a stride (550-700 mm)." },
        { check: "=isRamp || rise1 <= 0.22", message: "The risers are too tall." },
        { check: "=!twoFlights || n2 >= 2", message: "Too little rise for two flights." },
        { check: "=!isRamp || segs * (segLen + restL) < 40", message: "A ramp this long needs switchbacks." },
    ],
    regions: {
        treads: { label: "Treads", material: "=treadFinish" },
        structure: { label: "Structure", material: "=structureFinish" },
        rails: { label: "Rails", material: "=railFinish" },
        balusters: { label: "Balusters", material: "=balusterFinish" },
        glass: { label: "Glass", material: "glass.window" },
    },
    presets: [
        { name: "Interior flight", values: { rise: 2.7, width: 0.95, type: "straight", riserTarget: 0.18, going: 0.26, style: "closed", treadThickness: 0.035, nosing: 0.025, railSide: "right", railHeight: 0.9, balusters: "spindles", treadFinish: "wood.oak", structureFinish: "paint.white", railFinish: "wood.walnut", balusterFinish: "paint.white" } },
        { name: "Porch steps", values: { rise: 0.75, width: 1.6, type: "straight", riserTarget: 0.17, going: 0.3, style: "solid", treadThickness: 0.04, nosing: 0.02, railSide: "both", railHeight: 0.85, balusters: "spindles", treadFinish: "stone.sandstone", structureFinish: "masonry.brick", railFinish: "paint.white", balusterFinish: "paint.white" } },
        { name: "Quarter-turn with landing", values: { rise: 2.8, width: 1.0, type: "lLeft", riserTarget: 0.175, going: 0.27, style: "closed", railSide: "both", balusters: "spindles", treadFinish: "wood.walnut", structureFinish: "paint.white", railFinish: "wood.walnut" } },
        { name: "Loft steel stair", values: { rise: 3.0, width: 0.9, type: "landing", landingDepth: 0.95, riserTarget: 0.19, going: 0.25, style: "spine", treadThickness: 0.05, nosing: 0, railSide: "both", balusters: "glass", treadFinish: "wood.ash", structureFinish: "metal.black", railFinish: "metal.steel" } },
        { name: "Fire escape", values: { rise: 3.2, width: 0.8, type: "lRight", riserTarget: 0.2, going: 0.23, style: "open", treadThickness: 0.025, nosing: 0, railSide: "both", railHeight: 1.0, balusters: "bars", treadFinish: "metal.black", structureFinish: "metal.black", railFinish: "metal.black", balusterFinish: "metal.black", topLanding: true, landingDepth: 1.0 } },
        { name: "Access ramp", values: { rise: 0.9, width: 1.3, type: "ramp", gradient: 7, landingDepth: 1.5, railSide: "both", railHeight: 0.9, balusters: "bars", treadFinish: "masonry.concrete", structureFinish: "masonry.concrete", railFinish: "metal.steel", balusterFinish: "metal.steel" } },
    ],
    nodes: [
        // ===== Flights ===========================================================================
        ...flight("f1", "n1", "0"),
        { id: "flight1", type: "geo.transform", when: "=!isRamp", mesh: "@f1Unit" },
        ...flight("f2", "n2", "h1"),
        { id: "flight2", type: "geo.transform", when: "=twoFlights && n2 >= 2", mesh: "@f2Unit", rotate: [0, "=turn * -90", 0], at: ["=f2x", 0, "=f2z"] },
        // ===== Landings: a slab on posts, or solid to the ground ==================================
        { id: "midLanding", type: "mesh.box", when: "=twoFlights", size: ["=width", "=style == 'solid' ? h1 : tt * 1.6", "=midD"], at: [0, "=style == 'solid' ? h1 / 2 : h1 - tt * 0.8", "=midZ"], region: "treads" },
        { id: "midPosts", type: "mesh.box", when: "=twoFlights && style != 'solid'", repeat: 4, size: ["=postW", "=h1 - tt * 1.6", "=postW"], at: ["=(index % 2 * 2 - 1) * (width / 2 - postW / 2)", "=(h1 - tt * 1.6) / 2", "=midZ + (floor(index / 2) * 2 - 1) * (midD / 2 - postW / 2)"], region: "structure" },
        // The guard round the landing's open edges (its far side and, on a turn, the side away from the turn).
        { id: "midGuard", type: "mesh.cylinder", when: "=twoFlights && railSide != 'none'", repeat: "=turn == 0 ? 0 : 2", radius: 0.025, height: "=width", segments: 16, rotate: ["=index == 0 ? 0 : 90", 0, "=index == 0 ? -90 : 0"], at: ["=index == 0 ? -width / 2 : -turn * (width / 2 - 0.035)", "=h1 + railH", "=index == 0 ? midZ - midD / 2 + 0.035 : midZ - midD / 2"], region: "rails" },
        { id: "midGuardBars", type: "mesh.cylinder", when: "=twoFlights && turn != 0 && railSide != 'none' && balusters != 'none' && balusters != 'glass'", repeat: "=2 * floor(width / 0.12)", radius: "=balusters == 'bars' ? 0.008 : 0.016", height: "=railH", segments: 8, at: ["=index % 2 == 0 ? -width / 2 + (floor(index / 2) + 0.5) * 0.12 : -turn * (width / 2 - 0.035)", "=h1", "=index % 2 == 0 ? midZ - midD / 2 + 0.035 : midZ + midD / 2 - (floor(index / 2) + 0.5) * 0.12"], region: "balusters" },
        // An optional platform at the top.
        { id: "topSlab", type: "mesh.box", when: "=topLanding && !isRamp", size: ["=turn == 0 ? width : landingDepth", "=style == 'solid' ? rise : tt * 1.6", "=turn == 0 ? landingDepth : width"], at: ["=topX + turn * landingDepth / 2", "=style == 'solid' ? rise / 2 : rise - tt * 0.8", "=turn == 0 ? topZ - landingDepth / 2 : topZ"], region: "treads" },
        { id: "topPosts", type: "mesh.box", when: "=topLanding && !isRamp && style != 'solid'", repeat: 2, size: ["=postW", "=rise - tt * 1.6", "=postW"], at: ["=turn == 0 ? (index * 2 - 1) * (width / 2 - postW / 2) : topX + turn * (landingDepth - postW / 2)", "=(rise - tt * 1.6) / 2", "=turn == 0 ? topZ - landingDepth + postW / 2 : topZ + (index * 2 - 1) * (width / 2 - postW / 2)"], region: "structure" },
        // ===== Ramp ===============================================================================
        // Each run is a solid wedge (its side profile extruded across the width), then a level rest.
        {
            id: "rampRuns", type: "mesh.extrude", when: "=isRamp", repeat: "=segs", region: "treads",
            outline: [["=-index * (segLen + restL)", 0], ["=-index * (segLen + restL)", "=index * segRise + 0.001"], ["=-index * (segLen + restL) - segLen", "=(index + 1) * segRise"], ["=-index * (segLen + restL) - segLen", 0]],
            height: "=width", rotate: [-90, -90, 0], at: ["=-width / 2", 0, 0],
        },
        { id: "rampRests", type: "mesh.box", when: "=isRamp", repeat: "=segs", size: ["=width", "=(index + 1) * segRise", "=index == segs - 1 ? landingDepth : restL"], at: [0, "=(index + 1) * segRise / 2", "=-index * (segLen + restL) - segLen - (index == segs - 1 ? landingDepth : restL) / 2"], region: "structure" },
        { id: "rampCurbs", type: "mesh.box", when: "=isRamp", repeat: "=segs * 2", size: [0.1, 0.06, "=segLen / cos(rampA)"], rotate: ["=deg(rampA)", 0, 0], at: ["=(index % 2 * 2 - 1) * (width / 2 - 0.05)", "=(floor(index / 2) + 0.5) * segRise + 0.03", "=-floor(index / 2) * (segLen + restL) - segLen / 2"], region: "structure" },
        { id: "rampRails", type: "mesh.cylinder", when: "=isRamp && railSide != 'none'", repeat: "=segs * (railSide == 'both' ? 2 : 1)", radius: 0.025, height: "=segLen / cos(rampA) + 0.3", segments: 16, rotate: ["=deg(rampA) - 90", 0, 0], at: ["=(railSide == 'both' ? index % 2 * 2 - 1 : railSide == 'left' ? -1 : 1) * (width / 2 - 0.05)", "=floor(index / (railSide == 'both' ? 2 : 1)) * segRise + railH - 0.3 * gradient / 100", "=-floor(index / (railSide == 'both' ? 2 : 1)) * (segLen + restL) + 0.3"], region: "rails" },
        { id: "rampLevelRails", type: "mesh.cylinder", when: "=isRamp && railSide != 'none'", repeat: "=segs * (railSide == 'both' ? 2 : 1)", radius: 0.025, height: "=floor(index / (railSide == 'both' ? 2 : 1)) == segs - 1 ? landingDepth : restL", segments: 16, rotate: [-90, 0, 0], at: ["=(railSide == 'both' ? index % 2 * 2 - 1 : railSide == 'left' ? -1 : 1) * (width / 2 - 0.05)", "=(floor(index / (railSide == 'both' ? 2 : 1)) + 1) * segRise + railH", "=-floor(index / (railSide == 'both' ? 2 : 1)) * (segLen + restL) - segLen"], region: "rails" },
        { id: "rampPosts", type: "mesh.cylinder", when: "=isRamp && railSide != 'none'", repeat: "=(segs + 1) * (railSide == 'both' ? 2 : 1)", radius: 0.024, height: "=railH + 0.03", segments: 12, at: ["=(railSide == 'both' ? index % 2 * 2 - 1 : railSide == 'left' ? -1 : 1) * (width / 2 - 0.05)", "=floor(index / (railSide == 'both' ? 2 : 1)) * segRise", "=floor(index / (railSide == 'both' ? 2 : 1)) == segs ? -segs * (segLen + restL) + restL - landingDepth + 0.05 : -floor(index / (railSide == 'both' ? 2 : 1)) * (segLen + restL) - (floor(index / (railSide == 'both' ? 2 : 1)) == 0 ? -0.05 : 0)"], region: "balusters" },
    ],
    limits: { maxSize: 42, minSize: 0.3, maxTriangles: 120000 },
};

export default stair;
