import type { ObjectDef } from "../mesha_object";

// An Ashen Behemoth: the war beast the kingdoms below raise in the deep - an elephant's bulk on
// four pillar legs, a heavy domed head with a curling trunk, tusks swept forward, and a throat
// that glows with the fire it breathes. Bronze plates are strapped down its spine and a howdah
// rides on its back for the adept who guides it. Nose toward +Z, feet on y = 0, about 5 m to the
// top of the back.
//
// Each leg (and its foot) is its own region (legFL, legFR, legBL, legBR) so a game can swing them
// about the hip at `behemothHip()`; the rest is one rigid body.

/** Where the front-left leg turns (x, y, z) for a beast of `size` (1 = the default). The others mirror it on x and z. */
export function behemothHip(size = 1): [number, number, number] {
    return [1.05 * size, 2.6 * size, 1.7 * size];
}

/** Height of the howdah's floor (a rider stands here) and how far back it sits. */
export const behemothSeat = (size = 1): [number, number] => [5.05 * size, -1.05 * size];

export const behemothDef: ObjectDef = {
    id: "creature.behemoth",
    name: "Behemoth",
    category: "Nature",
    tags: ["creature", "elephant", "mammoth", "war beast", "mount", "beast", "animal", "fantasy", "tusks", "howdah", "fire", "abyss", "monster", "boss"],
    description: "A war beast of the deep: elephant bulk, pillar legs, a domed head with a curling trunk and forward tusks, a fire-glowing throat, bronze plates down its spine and a howdah for a rider.",
    featured: ["size", "tusks", "howdah", "hideFinish", "plateFinish"],
    groups: [{ id: "body", label: "Body" }, { id: "gear", label: "War gear" }, { id: "materials", label: "Materials" }],
    params: [
        { id: "size", label: "Size", type: "number", default: 1, min: 0.6, max: 1.5, group: "body", description: "1 is about 5 m to the top of the back." },
        { id: "tusks", label: "Tusks", type: "number", default: 1, min: 0, max: 1.5, group: "body", description: "Tusk length (0: none)." },
        { id: "ears", label: "Ears", type: "number", default: 1, min: 0.4, max: 1.4, group: "body" },
        { id: "plates", label: "Back plates", type: "int", default: 5, min: 0, max: 7, group: "gear" },
        { id: "howdah", label: "Howdah", type: "bool", default: true, group: "gear" },
        { id: "fire", label: "Fire throat", type: "bool", default: true, group: "gear", description: "The glow of the fire it breathes, under the trunk." },
        { id: "hideFinish", label: "Hide", type: "material", default: "stone.slate", materials: ["stone", "leather", "masonry"], group: "materials" },
        { id: "tuskFinish", label: "Tusks", type: "material", default: "stone.pale", materials: ["stone", "ceramic", "metal.bronze", "metal.gold"], group: "materials" },
        { id: "plateFinish", label: "Plates", type: "material", default: "metal.bronze", materials: ["metal"], group: "materials" },
        { id: "clothFinish", label: "Howdah cloth", type: "material", default: "cloth.wine", materials: ["cloth", "fabric"], group: "materials", visibleIf: "=howdah" },
        { id: "fireFinish", label: "Fire", type: "material", default: "glow.amber", materials: ["glow"], group: "materials", visibleIf: "=fire" },
    ],
    derived: {
        s: "=size",
        hx: "=1.05 * size", hz: "=1.7 * size", hy: "=2.6 * size",
    },
    regions: {
        hide: { label: "Hide", material: "=hideFinish" },
        legFL: { label: "Front left leg", material: "=hideFinish" },
        legFR: { label: "Front right leg", material: "=hideFinish" },
        legBL: { label: "Back left leg", material: "=hideFinish" },
        legBR: { label: "Back right leg", material: "=hideFinish" },
        tusk: { label: "Tusks", material: "=tuskFinish" },
        plate: { label: "Plates", material: "=plateFinish" },
        wood: { label: "Howdah frame", material: "wood.weathered" },
        cloth: { label: "Howdah cloth", material: "=clothFinish" },
        fire: { label: "Fire throat", material: "=fireFinish" },
        eye: { label: "Eyes", material: "glow.amber" },
    },
    presets: [
        { name: "Ashen Behemoth", values: {} },
        { name: "Old bull", values: { size: 1.25, tusks: 1.4, plates: 7, plateFinish: "metal.verdigris" } },
        { name: "Pack beast", values: { size: 0.8, tusks: 0.4, plates: 0, howdah: false, fire: false, hideFinish: "leather.tan" } },
    ],
    nodes: [
        // --- The body: a great barrel, a shoulder hump, the belly slung low ---
        { id: "ball", type: "mesh.sphere", output: false, radius: 0.5, segments: 20, rings: 12 },
        { id: "barrel", type: "deform.noise", output: false, mesh: "@ball", amount: 0.012, frequency: 2.5, octaves: 2, seed: 4, scale: ["=3.2 * s", "=3.0 * s", "=5.4 * s"], at: [0, "=3.3 * s", "=-0.2 * s"], region: "hide" },
        { id: "hump", type: "geo.transform", output: false, mesh: "@ball", scale: ["=2.6 * s", "=1.6 * s", "=2.6 * s"], at: [0, "=4.3 * s", "=1.1 * s"], region: "hide" },
        { id: "rump", type: "geo.transform", output: false, mesh: "@ball", scale: ["=2.7 * s", "=2.4 * s", "=2.4 * s"], at: [0, "=3.5 * s", "=-1.9 * s"], region: "hide" },
        // --- Legs: thick tapering pillars, broad round feet ---
        { id: "pillar", type: "mesh.cone", output: false, bottomRadius: "=0.52 * s", topRadius: "=0.7 * s", height: "=2.75 * s", segments: 14 },
        { id: "foot", type: "mesh.cylinder", output: false, radius: "=0.66 * s", height: "=0.32 * s", segments: 14, bevel: "=0.08 * s", bevelSegments: 2 },
        { id: "legFL", type: "geo.join", output: false, meshes: ["@pillar", "@foot"], at: ["=hx", 0, "=hz"], region: "legFL" },
        { id: "legFR", type: "geo.join", output: false, meshes: ["@pillar", "@foot"], at: ["=-hx", 0, "=hz"], region: "legFR" },
        { id: "legBL", type: "geo.join", output: false, meshes: ["@pillar", "@foot"], at: ["=hx", 0, "=-hz"], region: "legBL" },
        { id: "legBR", type: "geo.join", output: false, meshes: ["@pillar", "@foot"], at: ["=-hx", 0, "=-hz"], region: "legBR" },
        // --- The head: a high dome, ears like shields, the trunk curling down over the fire throat ---
        { id: "head", type: "geo.transform", output: false, mesh: "@ball", scale: ["=2.0 * s", "=2.1 * s", "=2.1 * s"], at: [0, "=4.1 * s", "=3.1 * s"], region: "hide" },
        { id: "brow", type: "geo.transform", output: false, mesh: "@ball", scale: ["=1.5 * s", "=0.9 * s", "=1.2 * s"], at: [0, "=4.85 * s", "=3.55 * s"], region: "hide" },
        { id: "ear", type: "deform.noise", output: false, repeat: 2, mesh: "@ball", amount: "=0.05 * s", frequency: 2, octaves: 2, seed: "=index + 3",
            scale: ["=0.22 * s", "=1.7 * s * ears", "=1.45 * s * ears"], rotate: [0, "=index == 0 ? -28 : 28", "=index == 0 ? 12 : -12"],
            at: ["=(index == 0 ? 1.15 : -1.15) * s", "=4.05 * s", "=2.55 * s"], region: "hide" },
        { id: "trunkPath", type: "path.bezier", output: false, p0: [0, "=3.75 * s", "=3.95 * s"], p1: [0, "=3.2 * s", "=5.0 * s"], p2: [0, "=1.4 * s", "=4.95 * s"], p3: [0, "=1.0 * s", "=4.35 * s"], segments: 18 },
        { id: "trunk", type: "mesh.sweep", output: false, path: "@trunkPath", radius: "=0.46 * s", taper: 0.4, sides: 12, region: "hide" },
        { id: "throat", type: "mesh.sphere", output: false, when: "=fire", radius: "=0.42 * s", segments: 12, rings: 8, at: [0, "=2.96 * s", "=4.35 * s"], region: "fire" },
        { id: "eyes", type: "mesh.sphere", output: false, repeat: 2, radius: "=0.11 * s", segments: 8, rings: 6, at: ["=(index == 0 ? 0.82 : -0.82) * s", "=4.45 * s", "=3.95 * s"], region: "eye" },
        { id: "tuskPathL", type: "path.bezier", output: false, p0: ["=0.55 * s", "=3.05 * s", "=3.85 * s"], p1: ["=0.75 * s", "=2.2 * s", "=(3.9 + 1.0 * tusks) * s"], p2: ["=0.85 * s", "=2.3 * s", "=(4.2 + 1.7 * tusks) * s"], p3: ["=0.95 * s", "=(2.7 + 0.5 * tusks) * s", "=(4.3 + 2.2 * tusks) * s"], segments: 12 },
        { id: "tuskL", type: "mesh.sweep", output: false, when: "=tusks > 0.05", path: "@tuskPathL", radius: "=0.17 * s", taper: 0.12, sides: 10, region: "tusk" },
        { id: "tusks", type: "instance.mirror", output: false, when: "=tusks > 0.05", mesh: "@tuskL", axis: "x" },
        { id: "tailPath", type: "path.bezier", output: false, p0: [0, "=3.9 * s", "=-3.0 * s"], p1: [0, "=3.3 * s", "=-3.6 * s"], p2: [0, "=2.4 * s", "=-3.55 * s"], p3: [0, "=1.7 * s", "=-3.4 * s"], segments: 10 },
        { id: "tail", type: "mesh.sweep", output: false, path: "@tailPath", radius: "=0.13 * s", taper: 0.5, sides: 8, region: "hide" },
        // --- War gear: bronze plates strapped down the spine, the howdah on the back ---
        { id: "plateBox", type: "mesh.box", output: false, size: [1, 1, 1], radius: 0.1, segments: 1 },
        { id: "platesNode", type: "geo.transform", output: false, when: "=plates > 0", repeat: "=plates", mesh: "@plateBox",
            scale: ["=2.3 * s", "=0.16 * s", "=0.95 * s"], rotate: ["=-14 + index * 7", 0, 0],
            at: [0, "=(4.82 - abs(index - 2) * 0.12) * s", "=(2.0 - index * 0.85) * s"], region: "plate" },
        { id: "deck", type: "mesh.box", output: false, when: "=howdah", size: ["=2.0 * s", "=0.18 * s", "=2.0 * s"], radius: 0.04, segments: 1, at: [0, "=4.96 * s", "=-1.05 * s"], region: "wood" },
        { id: "posts", type: "mesh.cylinder", output: false, when: "=howdah", repeat: 4, radius: "=0.06 * s", height: "=1.45 * s", segments: 6,
            at: ["=(index % 2 == 0 ? 0.88 : -0.88) * s", "=5.05 * s", "=(-1.05 + (index < 2 ? 0.88 : -0.88)) * s"], region: "wood" },
        { id: "rails", type: "mesh.box", output: false, when: "=howdah", repeat: 4, size: ["=index < 2 ? 1.8 * s : 0.06 * s", "=0.06 * s", "=index < 2 ? 0.06 * s : 1.8 * s"],
            at: ["=index == 2 ? 0.88 * s : index == 3 ? -0.88 * s : 0", "=5.62 * s", "=(-1.05 + (index == 0 ? 0.88 : index == 1 ? -0.88 : 0)) * s"], region: "wood" },
        { id: "canopy", type: "mesh.cone", output: false, when: "=howdah", bottomRadius: "=1.45 * s", topRadius: "=0.05 * s", height: "=0.9 * s", segments: 8, at: [0, "=6.5 * s", "=-1.05 * s"], region: "cloth" },
        { id: "skirt", type: "mesh.box", output: false, when: "=howdah", repeat: 2, size: ["=0.05 * s", "=1.1 * s", "=2.2 * s"], at: ["=(index == 0 ? 1.62 : -1.62) * s", "=4.35 * s", "=-1.05 * s"], rotate: [0, 0, "=index == 0 ? -12 : 12"], region: "cloth" },
        {
            id: "behemoth", type: "geo.join",
            meshes: ["@barrel", "@hump", "@rump", "@legFL", "@legFR", "@legBL", "@legBR", "@head", "@brow", "@ear", "@trunk", "@throat", "@eyes", "@tusks", "@tail", "@platesNode", "@deck", "@posts", "@rails", "@canopy", "@skirt"],
        },
    ],
    limits: { maxSize: 18, minSize: 1, maxTriangles: 40000 },
};

export default behemothDef;
