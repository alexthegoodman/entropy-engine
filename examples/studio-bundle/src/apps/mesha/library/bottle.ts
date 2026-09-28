import type { ObjectDef } from "../mesha_object";

/** A glass bottle turned from one profile: body, shoulder, neck and lip, with a wrap label and a closure. */
const bottle: ObjectDef = {
    id: "household.bottle",
    name: "Bottle",
    category: "Household",
    tags: ["bottle", "wine bottle", "beer bottle", "glass", "flask", "jar", "container"],
    description: "Wine, beer, milk or apothecary bottle with label and cap.",
    featured: ["height", "bodyRadius", "shoulder", "neckRadius", "closure", "glass"],
    groups: [
        { id: "body", label: "Body" },
        { id: "neck", label: "Neck" },
        { id: "label", label: "Label" },
        { id: "closure", label: "Closure" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 0.3, min: 0.08, max: 0.5, unit: "m", group: "body" },
        { id: "bodyRadius", label: "Body radius", type: "number", default: 0.038, min: 0.015, max: "=height * 0.35", unit: "m", group: "body" },
        { id: "bodyShare", label: "Body height", type: "number", default: 0.58, min: 0.3, max: 0.8, group: "body", description: "Share of the height that is straight body." },
        { id: "shoulder", label: "Shoulder", type: "enum", default: "round", options: ["round", "sloped", "square"], optionLabels: ["Round", "Sloped", "Square"], group: "body" },
        { id: "waist", label: "Waist", type: "number", default: 0, min: -0.15, max: 0.15, group: "body", description: "Pinches (negative) or swells the middle of the body." },
        { id: "punt", label: "Punt", type: "number", default: 0.35, min: 0, max: 1, group: "body", description: "How deep the dimple in the base goes." },
        { id: "neckRadius", label: "Neck radius", type: "number", default: 0.013, min: 0.006, max: "=bodyRadius * 0.9", unit: "m", group: "neck" },
        { id: "neckShare", label: "Neck length", type: "number", default: 0.6, min: 0.15, max: 0.9, group: "neck", description: "Share of the remaining height above the shoulder." },
        { id: "lip", label: "Lip", type: "number", default: 0.5, min: 0, max: 1, group: "neck" },
        { id: "label", label: "Label", type: "bool", default: true, group: "label" },
        { id: "labelHeight", label: "Label height", type: "number", default: 0.55, min: 0.2, max: 0.95, group: "label", visibleIf: "=label" },
        { id: "labelWrap", label: "Label wrap", type: "number", default: 250, min: 60, max: 360, unit: "°", group: "label", visibleIf: "=label" },
        { id: "closure", label: "Closure", type: "enum", default: "cork", options: ["none", "cork", "screw", "crown"], optionLabels: ["None", "Cork", "Screw cap", "Crown cap"], group: "closure" },
        { id: "glass", label: "Glass", type: "material", default: "glass.green", materials: ["glass"], group: "materials" },
        { id: "labelFinish", label: "Label", type: "material", default: "paper.label", materials: ["paper", "metal.brass", "paint"], group: "materials" },
        { id: "capFinish", label: "Cap", type: "material", default: "metal.aluminum", materials: ["metal", "plastic"], group: "materials", visibleIf: "=closure == 'screw' || closure == 'crown'" },
        { id: "seed", label: "Seed", type: "seed", default: 3, group: "materials", variation: 0 },
    ],
    derived: {
        r: "=bodyRadius",
        bodyTop: "=height * bodyShare",
        rest: "=height - bodyTop",
        shoulderTop: "=bodyTop + rest * (1 - neckShare)",
        lipH: "=clamp(neckRadius * 0.9, 0.004, 0.02) * (0.4 + lip)",
        lipR: "=neckRadius * (1 + 0.18 * lip)",
        puntD: "=punt * min(r * 0.5, height * 0.08)",
        labelY0: "=bodyTop * (1 - labelHeight) * 0.55 + 0.004",
        labelY1: "=labelY0 + bodyTop * labelHeight",
        wr: "=r * (1 + waist)",
    },
    rules: [
        { check: "=shoulderTop - bodyTop > (r - neckRadius) * 0.35 || shoulder == 'square'", message: "The shoulder is too steep for the neck width; lengthen it or shorten the neck." },
        { check: "=height > r * 2.2", message: "Too squat to read as a bottle." },
    ],
    regions: {
        glass: { label: "Glass", material: "=glass" },
        label: { label: "Label", material: "=labelFinish" },
        cork: { label: "Cork", material: "cork" },
        cap: { label: "Cap", material: "=capFinish" },
    },
    presets: [
        { name: "Bordeaux", values: { height: 0.3, bodyRadius: 0.037, bodyShare: 0.6, shoulder: "round", neckRadius: 0.0125, neckShare: 0.62, closure: "cork", glass: "glass.green" } },
        { name: "Burgundy", values: { height: 0.3, bodyRadius: 0.041, bodyShare: 0.45, shoulder: "sloped", neckRadius: 0.0125, neckShare: 0.4, closure: "cork", glass: "glass.amber" } },
        { name: "Longneck beer", values: { height: 0.24, bodyRadius: 0.03, bodyShare: 0.5, shoulder: "sloped", neckRadius: 0.012, neckShare: 0.65, closure: "crown", glass: "glass.amber", labelHeight: 0.45 } },
        { name: "Milk", values: { height: 0.22, bodyRadius: 0.042, bodyShare: 0.62, shoulder: "round", neckRadius: 0.022, neckShare: 0.35, closure: "screw", glass: "glass.clear", capFinish: "plastic.red", punt: 0 } },
        { name: "Apothecary", values: { height: 0.13, bodyRadius: 0.03, bodyShare: 0.62, shoulder: "square", neckRadius: 0.011, neckShare: 0.5, closure: "screw", glass: "glass.amber", capFinish: "plastic.black", labelFinish: "paper.kraft" } },
    ],
    nodes: [
        {
            id: "profile", type: "curve.points", output: false, filletSegments: 6,
            fillet: "=shoulder == 'square' ? r * 0.18 : shoulder == 'round' ? min(r - neckRadius, shoulderTop - bodyTop) * 0.8 : r * 0.25",
            points: {
                switch: "=shoulder",
                cases: {
                    sloped: [[0, "=puntD"], ["=r * 0.72", 0], ["=r", "=r * 0.12"], ["=wr", "=bodyTop * 0.5"], ["=r", "=bodyTop"], ["=neckRadius", "=shoulderTop"], ["=neckRadius", "=height - lipH"], ["=lipR", "=height - lipH * 0.8"], ["=lipR", "=height - lipH * 0.15"], ["=neckRadius * 0.95", "=height"], [0, "=height"]],
                },
                default: [[0, "=puntD"], ["=r * 0.72", 0], ["=r", "=r * 0.12"], ["=wr", "=bodyTop * 0.5"], ["=r", "=bodyTop"], ["=r", "=bodyTop + (shoulderTop - bodyTop) * 0.35"], ["=neckRadius", "=shoulderTop"], ["=neckRadius", "=height - lipH"], ["=lipR", "=height - lipH * 0.8"], ["=lipR", "=height - lipH * 0.15"], ["=neckRadius * 0.95", "=height"], [0, "=height"]],
            },
        },
        { id: "body", type: "mesh.lathe", profile: "@profile", segments: 48, smoothAngle: 60, region: "glass" },
        {
            id: "labelProfile", type: "curve.points", output: false,
            points: [["=wr * 1.0 + 0.0004", "=labelY0"], ["=wr + 0.0011", "=labelY0"], ["=wr + 0.0011", "=labelY1"], ["=wr + 0.0004", "=labelY1"]],
        },
        { id: "label", type: "mesh.lathe", when: "=label && labelY1 < bodyTop", profile: "@labelProfile", segments: 48, sweep: "=labelWrap", smoothAngle: 30, rotate: [0, "=90 - labelWrap / 2", 0], region: "label" },
        {
            id: "corkProfile", type: "curve.points", output: false, fillet: 0.0015,
            points: [["=neckRadius * 0.82", "=height - 0.004"], ["=neckRadius * 0.85", "=height + neckRadius * 0.9"], ["=neckRadius * 0.8", "=height + neckRadius * 1.1"]],
        },
        { id: "cork", type: "mesh.lathe", when: "=closure == 'cork'", profile: "@corkProfile", cap: true, segments: 24, region: "cork" },
        { id: "screwCap", type: "mesh.cylinder", when: "=closure == 'screw'", radius: "=lipR * 1.12", height: "=lipH * 2.4", segments: 40, bevel: "=lipH * 0.3", at: [0, "=height - lipH * 1.8", 0], region: "cap" },
        { id: "capRibs", type: "mesh.box", when: "=closure == 'screw'", repeat: 28, size: [0.0012, "=lipH * 2.0", 0.0012], at: ["=cos(index / count * TAU) * lipR * 1.12", "=height - lipH * 0.6", "=-sin(index / count * TAU) * lipR * 1.12"], region: "cap" },
        {
            id: "crownProfile", type: "curve.points", output: false, fillet: 0.0008,
            points: [["=lipR * 1.12", "=height - lipH * 0.7"], ["=lipR * 1.2", "=height - lipH * 0.25"], ["=lipR * 1.05", "=height + 0.002"], [0, "=height + 0.0025"]],
        },
        { id: "crown", type: "mesh.lathe", when: "=closure == 'crown'", profile: "@crownProfile", cap: true, segments: 21, smoothAngle: 20, region: "cap" },
    ],
    limits: { maxSize: 0.6, minSize: 0.05, maxTriangles: 30000 },
};

export default bottle;
