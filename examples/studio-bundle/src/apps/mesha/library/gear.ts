import type { ObjectDef } from "../mesha_object";

/** A spur gear lying flat: toothed rim, web with spokes or lightening holes, hub and keyed bore. */
const gear: ObjectDef = {
    id: "mechanical.gear",
    name: "Gear",
    category: "Mechanical",
    tags: ["gear", "cog", "sprocket", "spur gear", "wheel", "machine part"],
    description: "Spur gear with solid, spoked or drilled web and a hub.",
    featured: ["teeth", "module", "thickness", "web", "hub", "finish"],
    groups: [
        { id: "teeth", label: "Teeth" },
        { id: "body", label: "Body" },
        { id: "hub", label: "Hub" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "teeth", label: "Teeth", type: "int", default: 32, min: 8, max: 120, group: "teeth" },
        { id: "module", label: "Tooth size", type: "number", default: 0.004, min: 0.001, max: "=min(0.02, 1.4 / (teeth + 2))", unit: "m", decimals: 4, group: "teeth", description: "Pitch diameter / teeth (the gear 'module')." },
        { id: "toothWidth", label: "Tooth width", type: "number", default: 0.42, min: 0.25, max: 0.6, group: "teeth" },
        { id: "thickness", label: "Thickness", type: "number", default: 0.012, min: 0.002, max: 0.08, unit: "m", group: "body" },
        { id: "chamfer", label: "Edge chamfer", type: "number", default: 0.3, min: 0, max: 1, group: "body" },
        { id: "web", label: "Web", type: "enum", default: "spokes", options: ["solid", "spokes", "holes"], optionLabels: ["Solid", "Spokes", "Drilled"], group: "body" },
        { id: "openings", label: "Openings", type: "int", default: 5, min: 3, max: 12, group: "body", visibleIf: "=web != 'solid'" },
        { id: "rim", label: "Rim width", type: "number", default: 0.14, min: 0.06, max: 0.3, group: "body", visibleIf: "=web != 'solid'", description: "Share of the radius kept solid inside the teeth." },
        { id: "hub", label: "Hub", type: "bool", default: true, group: "hub" },
        { id: "hubSize", label: "Hub size", type: "number", default: 0.3, min: 0.15, max: 0.5, group: "hub", visibleIf: "=hub" },
        { id: "hubHeight", label: "Hub height", type: "number", default: 1.8, min: 1, max: 4, group: "hub", visibleIf: "=hub", description: "Multiple of the thickness." },
        { id: "bore", label: "Bore", type: "number", default: 0.4, min: 0, max: 0.8, group: "hub", description: "Share of the hub radius." },
        { id: "finish", label: "Finish", type: "material", default: "metal.steel", materials: ["metal", "plastic", "wood"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 11, group: "materials", variation: 0 },
    ],
    derived: {
        pitchR: "=teeth * module / 2",
        tipR: "=pitchR + module",
        rootR: "=pitchR - module * 1.25",
        rimInner: "=rootR * (1 - rim)",
        hubR: "=pitchR * hubSize",
        boreR: "=hubR * bore",
        hubH: "=thickness * (hub ? hubHeight : 1)",
        webInner: "=hub ? hubR : max(boreR * 1.6, pitchR * 0.18)",
        spokeW: "=(rimInner - webInner) * 0.18",
        // Openings only where they fit between hub and rim; otherwise the web stays solid.
        openWeb: "=web != 'solid' && rimInner > webInner + module * 2",
    },
    rules: [
        { check: "=rimInner > webInner + module * 2 || web == 'solid'", message: "No room for openings between the hub and the rim, so the web is left solid." },
        { check: "=module * 2.25 < rootR", message: "Teeth too large for the gear." },
    ],
    regions: { gear: { label: "Gear", material: "=finish" } },
    presets: [
        { name: "Clock wheel", values: { teeth: 60, module: 0.001, thickness: 0.002, web: "spokes", openings: 4, rim: 0.1, hub: true, hubSize: 0.18, finish: "metal.brass", chamfer: 0.15 } },
        { name: "Industrial", values: { teeth: 24, module: 0.008, thickness: 0.04, web: "holes", openings: 6, rim: 0.2, hub: true, hubSize: 0.36, hubHeight: 1.4, finish: "metal.black" } },
        { name: "Printed pinion", values: { teeth: 12, module: 0.0025, thickness: 0.01, web: "solid", hub: true, hubSize: 0.5, hubHeight: 2.4, finish: "plastic.red" } },
    ],
    nodes: [
        { id: "outline", type: "curve.gear", output: false, teeth: "=teeth", root: "=rootR", tip: "=tipR", toothWidth: "=toothWidth", flank: 0.22 },
        { id: "bore", type: "curve.circle", output: false, radius: "=max(boreR, 0.0005)", segments: 40 },
        { id: "spokeGap", type: "curve.sector", output: false, inner: "=webInner + spokeW * 0.6", outer: "=rimInner", start: "=spokeW / pitchR * 40", end: "=360 / openings - spokeW / pitchR * 40", radius: "=spokeW * 0.9" },
        // Drilled holes stay narrower than their spacing around the circle, so neighbours never merge.
        { id: "hole", type: "curve.circle", output: false, radius: "=min((rimInner - webInner) * 0.36, PI * (rimInner + webInner) / 2 / openings * 0.36)", center: ["=(rimInner + webInner) / 2", 0], segments: 32 },
        { id: "openingsList", type: "curves.radial", output: false, curve: { if: "=web == 'holes'", then: "@hole", else: "@spokeGap" }, count: "=openings" },
        {
            id: "wheel", type: "mesh.extrude", region: "gear",
            outline: "@outline", holes: { if: "=openWeb", then: ["@bore", "@openingsList"], else: ["@bore"] },
            height: "=thickness", bevel: "=min(module * 0.35, thickness * 0.3, (webInner - boreR) * 0.3 + 0.00005) * chamfer", bevelSegments: 2, smoothAngle: 30,
            at: [0, "=(hubH - thickness) / 2", 0],
        },
        {
            id: "hubRing", type: "mesh.extrude", when: "=hub && hubHeight > 1.01", region: "gear",
            outline: "@hubOutline", holes: ["@bore"], height: "=hubH", bevel: "=min(hubH * 0.08 * chamfer + 0.0002, (hubR - boreR) * 0.3)", bevelSegments: 3,
        },
        { id: "hubOutline", type: "curve.circle", output: false, radius: "=hubR", segments: 48 },
    ],
    limits: { maxSize: 1.5, minSize: 0.005, maxTriangles: 80000 },
};

export default gear;
