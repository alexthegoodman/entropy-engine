import type { ObjectDef } from "../mesha_object";

// A shrine of the sacred river: a round stepped platform, a ring of carved pillars joined by a
// lintel ring, and at its heart a basin of the river's water, glowing, with a tall spire over it
// crowned by a crystal. Two channels run out of the basin across the platform to the river.
// `broken` shatters it: pillars fall (some lie across the steps), the lintel breaks into
// pieces, the spire leans and its crystal goes dark, the basin's light dims to a few embers.
// Centered on the origin, standing on the ground; the channels run along +X and -X.

export const riverShrineDef: ObjectDef = {
    id: "architecture.river_shrine",
    name: "River Shrine",
    category: "Architecture",
    tags: ["shrine", "temple", "altar", "sacred", "river", "fountain", "basin", "pillars", "colonnade", "underground", "fantasy", "magic", "abyss", "ruin"],
    description: "A round shrine to a sacred river: stepped platform, a ring of carved pillars under a lintel, a glowing basin with channels to the river, and a crystal-crowned spire. It can be shattered.",
    featured: ["radius", "pillars", "spireHeight", "glow", "broken", "stoneFinish"],
    groups: [
        { id: "platform", label: "Platform" },
        { id: "colonnade", label: "Colonnade" },
        { id: "heart", label: "Basin and spire" },
        { id: "state", label: "Condition" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "radius", label: "Radius", type: "number", default: 9, min: 5, max: 16, unit: "m", group: "platform" },
        { id: "steps", label: "Steps", type: "int", default: 3, min: 1, max: 6, group: "platform" },
        { id: "stepHeight", label: "Step height", type: "number", default: 0.32, min: 0.18, max: 0.45, unit: "m", group: "platform" },
        { id: "channels", label: "Channels", type: "bool", default: true, group: "platform" },
        { id: "pillars", label: "Pillars", type: "int", default: 10, min: 4, max: 20, group: "colonnade" },
        { id: "pillarHeight", label: "Pillar height", type: "number", default: 4.6, min: 2.8, max: 8, unit: "m", group: "colonnade" },
        { id: "lintel", label: "Lintel ring", type: "bool", default: true, group: "colonnade" },
        { id: "spireHeight", label: "Spire height", type: "number", default: 8, min: 3, max: 16, unit: "m", group: "heart" },
        { id: "glow", label: "Water's light", type: "material", default: "glow.river", materials: ["glow.river", "glow.riverViolet", "glow.riverGold", "glow.cyan"], group: "heart" },
        { id: "broken", label: "Broken", type: "number", default: 0, min: 0, max: 1, group: "state", description: "Fallen pillars, a broken lintel, the spire leaning, its crystal dark." },
        { id: "stoneFinish", label: "Stone", type: "material", default: "stone.pale", materials: ["stone", "masonry.fieldstone"], group: "materials" },
        { id: "trimFinish", label: "Carvings", type: "material", default: "metal.verdigris", materials: ["metal.verdigris", "metal.bronze", "metal.gold", "stone"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 3, group: "materials", variation: 0 },
    ],
    derived: {
        R: "=radius", sh: "=stepHeight",
        deck: "=steps * stepHeight",
        ring: "=radius * 0.72",
        basinR: "=max(1.4, radius * 0.24)",
        lean: "=broken * 24",
        // The spire's axis once leaned (rotate x then z, as nodes do).
        lx: "=-sin(rad(broken * 24 * 0.4)) * cos(rad(broken * 24 * 0.7))",
        ly: "=cos(rad(broken * 24 * 0.4)) * cos(rad(broken * 24 * 0.7))",
        lz: "=sin(rad(broken * 24 * 0.7))",
        dark: "=broken > 0.5",
    },
    rules: [
        { check: "=spireHeight > 2 * stepHeight", message: "The spire must stand above the platform." },
    ],
    regions: {
        stone: { label: "Stone", material: "=stoneFinish" },
        trim: { label: "Carvings", material: "=trimFinish" },
        water: { label: "Water", material: "=dark ? 'water.toxic' : glow" },
        embers: { label: "Embers", material: "=glow" },
        crystal: { label: "Crystal", material: "=dark ? 'glass.violet' : glow" },
        rubble: { label: "Rubble", material: "=stoneFinish" },
    },
    presets: [
        { name: "Shrine of the river", values: {} },
        { name: "Violet spring", values: { glow: "glow.riverViolet", pillars: 12, radius: 11, trimFinish: "metal.gold" } },
        { name: "Wayside shrine", values: { radius: 5.5, pillars: 6, steps: 2, spireHeight: 4.5, channels: false } },
        { name: "Desecrated", values: { broken: 0.85, seed: 5 } },
        { name: "Cracked", values: { broken: 0.4, seed: 8, glow: "glow.riverGold" } },
    ],
    nodes: [
        // The stepped platform.
        { id: "stepRings", type: "mesh.cylinder", repeat: "=steps", radius: "=R - index * 0.55", height: "=sh", segments: 40, bevel: 0.03, at: [0, "=index * sh", 0], region: "stone" },
        { id: "rim", type: "mesh.torus", major: "=R - (steps - 1) * 0.55 - 0.15", minor: 0.08, segments: 40, sides: 5, at: [0, "=deck", 0], region: "trim" },
        // Channels from the basin to the platform's edge (water in them when lit).
        { id: "channelBeds", type: "mesh.box", repeat: 2, when: "=channels", size: ["=R - basinR", 0.06, 0.55], at: ["=(index == 0 ? 1 : -1) * (basinR + (R - basinR) / 2)", "=deck + 0.01", 0], region: "water" },
        { id: "channelLips", type: "mesh.box", repeat: 4, when: "=channels", size: ["=R - basinR", 0.12, 0.12], at: ["=(index < 2 ? 1 : -1) * (basinR + (R - basinR) / 2)", "=deck + 0.03", "=index % 2 == 0 ? 0.34 : -0.34"], region: "trim" },
        // The basin and its water.
        {
            id: "basin", type: "mesh.lathe", segments: 32, smoothAngle: 50, region: "stone",
            profile: [[0, 0], ["=basinR + 0.2", 0], ["=basinR + 0.35", 0.25], ["=basinR + 0.3", 0.75], ["=basinR + 0.1", 0.85], ["=basinR - 0.05", 0.6], [0, 0.6]],
            at: [0, "=deck", 0],
        },
        { id: "waterSurface", type: "mesh.cylinder", radius: "=basinR - 0.05", height: 0.04, segments: 28, at: [0, "=deck + 0.66", 0], region: "water" },
        { id: "embersGlow", type: "mesh.icosphere", repeat: 5, when: "=dark", radius: 0.12, subdivisions: 1, at: ["=sin(rad(index * 72 + 20)) * basinR * rand(index, 2) * 0.8", "=deck + 0.7", "=cos(rad(index * 72 + 20)) * basinR * rand(index, 2) * 0.8"], region: "embers" },
        // The spire: a tapering, fluted obelisk from the basin, leaning when broken, and its crystal.
        {
            id: "spire", type: "mesh.cone", bottomRadius: 0.42, topRadius: 0.12, height: "=spireHeight", segments: 8, region: "stone",
            rotate: ["=lean * 0.7", 0, "=lean * 0.4"], at: [0, "=deck + 0.6", 0],
        },
        {
            id: "spireBands", type: "mesh.torus", repeat: 3, major: "=0.42 - (index + 1) * 0.07", minor: 0.05, segments: 12, sides: 4,
            rotate: ["=lean * 0.7", 0, "=lean * 0.4"], at: [
                "=lx * spireHeight * (index + 1) * 0.22", "=deck + 0.6 + ly * spireHeight * (index + 1) * 0.22", "=lz * spireHeight * (index + 1) * 0.22",
            ], region: "trim",
        },
        {
            id: "spireCrystal", type: "mesh.icosphere", radius: 0.42, subdivisions: 0, scale: [0.75, 1.8, 0.75],
            rotate: ["=lean * 0.7", 0, "=lean * 0.4"], at: [
                "=lx * (spireHeight + 0.7)", "=deck + 0.6 + ly * (spireHeight + 0.7)", "=lz * (spireHeight + 0.7)",
            ], region: "crystal",
        },
        // The colonnade: standing pillars, and those that fell lying across the steps.
        {
            id: "pillarShafts", type: "mesh.cylinder", repeat: "=pillars", radius: 0.32, height: "=pillarHeight", segments: 12, bevel: 0.02,
            at: ["=sin(rad(index * 360 / pillars)) * ring", "=deck", "=cos(rad(index * 360 / pillars)) * ring"],
            keep: "=rand(index, 1) >= broken * 0.65", region: "stone",
        },
        {
            id: "capitals", type: "mesh.box", repeat: "=pillars", size: 0.85, radius: 0.06, scale: [1, 0.35, 1],
            rotate: [0, "=index * 360 / pillars", 0],
            at: ["=sin(rad(index * 360 / pillars)) * ring", "=deck + pillarHeight", "=cos(rad(index * 360 / pillars)) * ring"],
            keep: "=rand(index, 1) >= broken * 0.65", region: "trim",
        },
        {
            id: "bases", type: "mesh.box", repeat: "=pillars", size: [0.9, 0.3, 0.9], radius: 0.04,
            at: ["=sin(rad(index * 360 / pillars)) * ring", "=deck + 0.15", "=cos(rad(index * 360 / pillars)) * ring"], region: "stone",
        },
        {
            id: "fallen", type: "mesh.cylinder", repeat: "=pillars", radius: 0.32, height: "=pillarHeight * (0.45 + rand(index, 5) * 0.4)", segments: 12,
            rotate: [90, "=index * 360 / pillars + (rand(index, 6) - 0.5) * 70", 0],
            at: ["=sin(rad(index * 360 / pillars)) * (ring + 0.4)", "=deck + 0.32", "=cos(rad(index * 360 / pillars)) * (ring + 0.4)"],
            keep: "=rand(index, 1) < broken * 0.65", region: "stone",
        },
        // The lintel: segments between neighbouring pillars, missing over the fallen ones.
        {
            id: "lintels", type: "mesh.box", repeat: "=pillars", when: "=lintel", size: ["=2 * ring * sin(rad(180 / pillars)) + 0.5", 0.45, 0.6],
            rotate: [0, "=(index + 0.5) * 360 / pillars", 0],
            at: ["=sin(rad((index + 0.5) * 360 / pillars)) * ring * cos(rad(180 / pillars))", "=deck + pillarHeight + 0.38", "=cos(rad((index + 0.5) * 360 / pillars)) * ring * cos(rad(180 / pillars))"],
            keep: "=rand(index, 1) >= broken * 0.65 && rand((index + 1) % pillars, 1) >= broken * 0.65 && rand(index, 9) >= broken * 0.5", region: "trim",
        },
        // Rubble scattered over the platform.
        {
            id: "rubble", type: "object", object: "component.rockPiece", repeat: "=round(broken * 14)", when: "=broken > 0.1",
            params: { size: "=0.3 + rand(index, 7) * 0.7", faceted: true, flatness: 0.6 },
            rotate: ["=rand(index, 8) * 50", "=rand(index, 9) * 360", 0],
            at: ["=sin(rad(rand(index, 11) * 360)) * (basinR + 1 + rand(index, 12) * (R - basinR - 1))", "=deck", "=cos(rad(rand(index, 11) * 360)) * (basinR + 1 + rand(index, 12) * (R - basinR - 1))"],
            region: "rubble",
        },
    ],
    limits: { maxSize: 40, minSize: 4, maxTriangles: 40000 },
};

export default riverShrineDef;
