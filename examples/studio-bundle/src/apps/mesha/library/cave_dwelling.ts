import type { ObjectDef } from "../mesha_object";

// A house of the kingdoms below: a tapering tower of carved cavestone in one to three tiers, each
// ringed by a carved band, under a dome or an onion roof with a crystal lamp on its finial. An arched
// doorway (dark inside, a bronze surround) faces +Z; round windows glow with the river's light or a
// candle's, and lanterns hang beside the door. `damage` wrecks it: the roof gone, the top tier
// fallen, the lamps dark and rubble round its foot. Standing on the ground at the origin.
//
//          *          crystal lamp
//         /^\         onion or dome roof
//        |___|        tier 2
//       |  o  |       carved band, windows
//      |   n   |      arched doorway (+Z), lanterns
//     [_________]     plinth

export const caveDwellingDef: ObjectDef = {
    id: "architecture.cave_dwelling",
    name: "Cavestone Dwelling",
    category: "Architecture",
    tags: ["house", "dwelling", "tower", "underground", "cave", "fantasy", "stone", "carved", "kingdom", "village", "abyss", "dome", "onion dome", "magic"],
    description: "A carved-stone tower house of an underground kingdom: one to three tapering tiers under a dome or onion roof crowned by a glowing crystal, an arched doorway, round windows lit by river light or candles, lanterns, and an optional state of ruin.",
    featured: ["radius", "tiers", "roof", "windowLight", "damage", "wallFinish"],
    groups: [
        { id: "body", label: "Tower" },
        { id: "roof", label: "Roof" },
        { id: "openings", label: "Door and windows" },
        { id: "state", label: "Condition" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "radius", label: "Radius", type: "number", default: 3.2, min: 2.2, max: 5.5, unit: "m", group: "body" },
        { id: "tierHeight", label: "Tier height", type: "number", default: 3.4, min: 2.8, max: 4.6, unit: "m", group: "body" },
        { id: "tiers", label: "Tiers", type: "int", default: 2, min: 1, max: 3, group: "body" },
        { id: "taper", label: "Taper", type: "number", default: 0.12, min: 0, max: 0.25, group: "body", description: "How much narrower each tier is at its top." },
        { id: "buttresses", label: "Buttresses", type: "int", default: 6, min: 0, max: 10, group: "body" },
        { id: "roof", label: "Roof", type: "enum", default: "onion", options: ["dome", "onion", "cone"], optionLabels: ["Dome", "Onion", "Spire"], group: "roof" },
        { id: "roofRise", label: "Roof rise", type: "number", default: 1, min: 0.6, max: 1.6, group: "roof" },
        { id: "crystal", label: "Crystal lamp", type: "bool", default: true, group: "roof" },
        { id: "windows", label: "Windows per tier", type: "int", default: 4, min: 0, max: 8, group: "openings" },
        { id: "windowLight", label: "Window light", type: "enum", default: "river", options: ["river", "candle", "dark"], optionLabels: ["River light", "Candlelight", "Dark"], group: "openings" },
        { id: "lanterns", label: "Door lanterns", type: "bool", default: true, group: "openings" },
        { id: "doorWidth", label: "Door width", type: "number", default: 1.25, min: 0.9, max: "=min(2, radius * 0.6)", unit: "m", group: "openings" },
        { id: "damage", label: "Damage", type: "number", default: 0, min: 0, max: 1, group: "state", description: "0 whole; past 0.4 the roof is gone and lamps are dark; past 0.7 the top tier has fallen." },
        { id: "wallFinish", label: "Walls", type: "material", default: "stone.carved", materials: ["stone", "masonry.fieldstone", "masonry.stucco"], group: "materials" },
        { id: "bandFinish", label: "Bands and surrounds", type: "material", default: "stone.pale", materials: ["stone", "metal.bronze", "metal.verdigris"], group: "materials" },
        { id: "roofFinish", label: "Roof", type: "material", default: "metal.verdigris", materials: ["metal.verdigris", "metal.bronze", "metal.copper", "stone", "roofing.slate"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 7, group: "materials", variation: 0 },
    ],
    derived: {
        R: "=radius", Ht: "=tierHeight",
        roofGone: "=damage > 0.4",
        standing: "=damage > 0.7 && tiers > 1 ? tiers - 1 : tiers",
        // Radius at the foot of tier k, and the total height of what stands.
        top: "=0.4 + standing * tierHeight",
        topR: "=radius * pow(1 - taper, standing) * 0.98",
        lit: "=windowLight != 'dark' && damage <= 0.4",
        doorH: "=min(tierHeight - 0.7, doorWidth * 1.7 + 0.2)",
    },
    rules: [
        { check: "=doorWidth < radius * 0.75", message: "The doorway is wider than the wall can carry." },
    ],
    regions: {
        wall: { label: "Walls", material: "=wallFinish" },
        band: { label: "Bands and surrounds", material: "=bandFinish" },
        roof: { label: "Roof", material: "=roofFinish" },
        dark: { label: "Doorway", material: "metal.black" },
        window: { label: "Windows", material: "=lit ? (windowLight == 'river' ? 'glow.river' : 'glow.candle') : 'glass.tinted'" },
        crystal: { label: "Crystal", material: "=damage > 0.4 ? 'glass.violet' : 'glow.river'" },
        lantern: { label: "Lanterns", material: "=damage > 0.4 ? 'glass.tinted' : 'glow.riverGold'" },
        bronze: { label: "Ironwork", material: "metal.bronze" },
        rubble: { label: "Rubble", material: "=wallFinish" },
    },
    presets: [
        { name: "River house", values: {} },
        { name: "Candlelit tower", values: { tiers: 3, roof: "cone", windowLight: "candle", radius: 2.8, roofFinish: "roofing.slate" } },
        { name: "Elder's dome", values: { tiers: 1, radius: 4.8, roof: "dome", windows: 6, roofFinish: "metal.bronze", bandFinish: "metal.verdigris" } },
        { name: "Shattered", values: { damage: 0.85, tiers: 3, windowLight: "dark", seed: 4 } },
        { name: "Roofless", values: { damage: 0.55, tiers: 2, roof: "dome", seed: 11 } },
    ],
    nodes: [
        { id: "plinth", type: "mesh.cylinder", radius: "=R + 0.35", height: 0.4, segments: 24, bevel: 0.08, region: "band" },
        // The tiers: tapering frusta, each a little narrower than the one below.
        {
            id: "tierBodies", type: "mesh.cone", repeat: "=standing", segments: 22,
            bottomRadius: "=R * pow(1 - taper, index)", topRadius: "=R * pow(1 - taper, index + 1)", height: "=Ht",
            at: [0, "=0.4 + index * Ht", 0], region: "wall",
        },
        {
            id: "bands", type: "mesh.torus", repeat: "=standing", major: "=R * pow(1 - taper, index + 1) + 0.04", minor: 0.14, segments: 26, sides: 6,
            at: [0, "=0.4 + (index + 1) * Ht - 0.12", 0], region: "band",
        },
        {
            id: "buttressFins", type: "mesh.box", repeat: "=buttresses", when: "=buttresses > 0", size: [0.35, "=Ht * 0.9", 0.7], radius: 0.06,
            rotate: [0, "=index * 360 / buttresses + 22", "=-deg(atan2(R * taper, Ht)) * 0.6"],
            at: ["=sin(rad(index * 360 / buttresses + 22)) * (R - 0.05)", "=0.4 + Ht * 0.45", "=cos(rad(index * 360 / buttresses + 22)) * (R - 0.05)"],
            keep: "=abs(sin(rad(index * 360 / buttresses + 22))) > 0.3 || cos(rad(index * 360 / buttresses + 22)) < 0", region: "wall",
        },
        // The arched doorway on +Z: a dark recess with an arch, in a raised surround.
        { id: "doorRecess", type: "mesh.box", size: ["=doorWidth", "=doorH - doorWidth / 2", 0.3], at: [0, "=0.4 + (doorH - doorWidth / 2) / 2", "=R - 0.08"], region: "dark" },
        { id: "doorArch", type: "mesh.cylinder", radius: "=doorWidth / 2", height: 0.3, segments: 14, rotate: [90, 0, 0], at: [0, "=0.4 + doorH - doorWidth / 2", "=R - 0.08 + 0.15"], region: "dark" },
        {
            id: "surround", type: "mesh.extrude", height: 0.12, bevel: 0.03, region: "band",
            outline: "@surroundOutline",
            holes: ["@surroundHole"],
            rotate: [-90, 0, 0], at: [0, 0.4, "=R + 0.2"],
        },
        { id: "surroundOutline", type: "curve.arch", output: false, width: "=doorWidth + 0.5", height: "=doorH + 0.25" },
        { id: "surroundHole", type: "curve.arch", output: false, width: "=doorWidth", height: "=doorH" },
        // Round windows round each standing tier (skipping the door's side on the ground tier).
        {
            id: "windowPanes", type: "mesh.cylinder", repeat: "=windows * standing", when: "=windows > 0", radius: 0.32, height: 0.12, segments: 12,
            rotate: [90, "=(index % windows) * 360 / windows + 180 / windows + floor(index / windows) * 23", 0],
            at: [
                "=sin(rad((index % windows) * 360 / windows + 180 / windows + floor(index / windows) * 23)) * R * pow(1 - taper, floor(index / windows) + 0.55)",
                "=0.4 + floor(index / windows) * Ht + Ht * 0.58",
                "=cos(rad((index % windows) * 360 / windows + 180 / windows + floor(index / windows) * 23)) * R * pow(1 - taper, floor(index / windows) + 0.55)",
            ],
            keep: "=floor(index / windows) > 0 || cos(rad((index % windows) * 360 / windows + 180 / windows)) < 0.8", region: "window",
        },
        {
            id: "windowRims", type: "mesh.torus", repeat: "=windows * standing", when: "=windows > 0", major: 0.36, minor: 0.06, segments: 12, sides: 5,
            rotate: [90, "=(index % windows) * 360 / windows + 180 / windows + floor(index / windows) * 23", 0],
            at: [
                "=sin(rad((index % windows) * 360 / windows + 180 / windows + floor(index / windows) * 23)) * (R * pow(1 - taper, floor(index / windows) + 0.55) + 0.04)",
                "=0.4 + floor(index / windows) * Ht + Ht * 0.58",
                "=cos(rad((index % windows) * 360 / windows + 180 / windows + floor(index / windows) * 23)) * (R * pow(1 - taper, floor(index / windows) + 0.55) + 0.04)",
            ],
            keep: "=floor(index / windows) > 0 || cos(rad((index % windows) * 360 / windows + 180 / windows)) < 0.8", region: "band",
        },
        // The roof and its crystal lamp (gone once damaged).
        {
            id: "roofShell", type: "mesh.lathe", when: "=!roofGone", segments: 24, smoothAngle: 70, region: "roof",
            profile: { switch: "=roof", cases: {
                dome: [[0, 0], ["=topR + 0.25", 0], ["=topR + 0.2", "=topR * 0.25 * roofRise"], ["=topR * 0.85", "=topR * 0.62 * roofRise"], ["=topR * 0.5", "=topR * 0.9 * roofRise"], [0, "=topR * roofRise"]],
                onion: [[0, 0], ["=topR + 0.2", 0], ["=topR * 1.12", "=topR * 0.35 * roofRise"], ["=topR * 1.05", "=topR * 0.7 * roofRise"], ["=topR * 0.6", "=topR * 1.15 * roofRise"], ["=topR * 0.18", "=topR * 1.5 * roofRise"], [0, "=topR * 1.85 * roofRise"]],
            }, default: [[0, 0], ["=topR + 0.3", 0], ["=topR * 0.55", "=topR * 1.1 * roofRise"], [0, "=topR * 2.4 * roofRise"]] },
            at: [0, "=top", 0],
        },
        { id: "finial", type: "mesh.cylinder", when: "=!roofGone", radius: 0.08, height: 0.8, segments: 8, at: [0, "=top + topR * roofRise * select(roof == 'dome' ? 0 : roof == 'onion' ? 1 : 2, 1, 1.85, 2.4) - 0.05", 0], region: "bronze" },
        {
            id: "crystalLamp", type: "mesh.icosphere", when: "=!roofGone && crystal", radius: 0.3, subdivisions: 0, scale: [0.7, 1.6, 0.7],
            at: [0, "=top + topR * roofRise * select(roof == 'dome' ? 0 : roof == 'onion' ? 1 : 2, 1, 1.85, 2.4) + 0.95", 0], region: "crystal",
        },
        // A broken crown where the roof was: jagged merlons of the top tier's wall.
        {
            id: "brokenCrown", type: "mesh.box", repeat: 9, when: "=roofGone", size: ["=topR * 0.5", "=0.3 + rand(index, 3) * 1.1", 0.45],
            rotate: [0, "=index * 40", 0], at: ["=sin(rad(index * 40)) * (topR - 0.2)", "=top + 0.1", "=cos(rad(index * 40)) * (topR - 0.2)"],
            keep: "=rand(index, 4) > 0.3", region: "wall",
        },
        // Lanterns either side of the door on bronze brackets.
        { id: "brackets", type: "mesh.box", repeat: 2, when: "=lanterns", size: [0.06, 0.06, 0.5], at: ["=(index == 0 ? 1 : -1) * (doorWidth / 2 + 0.45)", "=0.4 + doorH * 0.85", "=R + 0.15"], region: "bronze" },
        { id: "lanternGlass", type: "mesh.icosphere", repeat: 2, when: "=lanterns", radius: 0.16, subdivisions: 1, scale: [1, 1.3, 1], at: ["=(index == 0 ? 1 : -1) * (doorWidth / 2 + 0.45)", "=0.4 + doorH * 0.85 - 0.25", "=R + 0.38"], region: "lantern" },
        // Rubble from what fell.
        {
            id: "rubblePile", type: "object", object: "component.rockPiece", repeat: "=round(damage * 10)", when: "=damage > 0.15",
            params: { size: "=0.4 + rand(index, 7) * 0.9", faceted: true, flatness: 0.6 },
            rotate: ["=rand(index, 8) * 40", "=rand(index, 9) * 360", "=rand(index, 10) * 40"],
            at: ["=sin(rad(rand(index, 11) * 300 - 150 + 180)) * (R + 0.6 + rand(index, 12) * 2.2)", 0.1, "=cos(rad(rand(index, 11) * 300 - 150 + 180)) * (R + 0.6 + rand(index, 12) * 2.2)"],
            region: "rubble",
        },
    ],
    limits: { maxSize: 26, minSize: 2, maxTriangles: 40000 },
};

export default caveDwellingDef;
