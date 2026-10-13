import type { ObjectDef } from "../mesha_object";

// Waist-high cover: a run of concrete jersey barriers, a sandbag wall, or the dry-stone wall the
// kingdoms below raise round their fields. Built along +Z from the origin's side to side (centered
// on the origin, `length` long), standing on y = 0, about a meter tall - enough to crouch behind,
// low enough to shoot over standing.

export const barricadeDef: ObjectDef = {
    id: "street.barricade",
    name: "Barricade",
    category: "Street",
    tags: ["barricade", "barrier", "cover", "jersey barrier", "concrete barrier", "sandbags", "sandbag wall", "stone wall", "dry stone", "wall", "military", "checkpoint", "fortification", "war", "abyss"],
    description: "Waist-high cover: concrete jersey barriers, a staggered sandbag wall, or a dry-stone wall, in a run of any length.",
    featured: ["kind", "length", "height", "damage"],
    groups: [{ id: "shape", label: "Shape" }, { id: "materials", label: "Materials" }],
    params: [
        { id: "kind", label: "Kind", type: "enum", default: "jersey", options: ["jersey", "sandbags", "stone"], optionLabels: ["Jersey barrier", "Sandbag wall", "Dry-stone wall"], group: "shape" },
        { id: "length", label: "Length", type: "number", default: 6, min: 1.5, max: 18, unit: "m", group: "shape" },
        { id: "height", label: "Height", type: "number", default: 1, min: 0.6, max: 1.6, unit: "m", group: "shape" },
        { id: "damage", label: "Damage", type: "number", default: 0.3, min: 0, max: 1, group: "shape", description: "Chips, slumps and gaps." },
        { id: "concreteFinish", label: "Concrete", type: "material", default: "masonry.concrete", materials: ["masonry", "paint"], group: "materials", visibleIf: "=kind == 'jersey'" },
        { id: "stripeFinish", label: "Stripe", type: "material", default: "paint.signal", materials: ["paint"], group: "materials", visibleIf: "=kind == 'jersey'" },
        { id: "bagFinish", label: "Sandbags", type: "material", default: "fabric.sandbag", materials: ["fabric", "cloth"], group: "materials", visibleIf: "=kind == 'sandbags'" },
        { id: "stoneFinish", label: "Stone", type: "material", default: "masonry.fieldstone", materials: ["stone", "masonry"], group: "materials", visibleIf: "=kind == 'stone'" },
        { id: "seed", label: "Seed", type: "seed", default: 3, group: "materials", variation: 0 },
    ],
    derived: {
        L: "=length",
        Hh: "=height",
        // Jersey segments are 3 m; sandbags 0.55 m, laid in rows 0.15 m high; stones about 0.5 m.
        segs: "=max(1, round(length / 3))",
        segL: "=length / max(1, round(length / 3))",
        bagsRow: "=max(2, round(length / 0.52))",
        rows: "=max(3, round(height / 0.15))",
        stonesRow: "=max(2, round(length / 0.5))",
        stoneRows: "=max(2, round(height / 0.27))",
    },
    regions: {
        concrete: { label: "Concrete", material: "=concreteFinish" },
        stripe: { label: "Stripe", material: "=stripeFinish" },
        bags: { label: "Sandbags", material: "=bagFinish" },
        stone: { label: "Stone", material: "=stoneFinish" },
        cap: { label: "Capstones", material: "stone.dark" },
    },
    presets: [
        { name: "Jersey barriers", values: {} },
        { name: "Sandbag wall", values: { kind: "sandbags", length: 4, height: 1.05 } },
        { name: "Dry-stone wall", values: { kind: "stone", length: 7, height: 0.95, damage: 0.5 } },
        { name: "Firebase checkpoint", values: { length: 9, damage: 0.1, stripeFinish: "paint.white" } },
    ],
    nodes: [
        // --- Jersey barriers: the classic sloped profile, extruded and laid along +Z ---
        {
            id: "jerseyProfile", type: "curve.points", output: false, closed: true,
            points: [[-0.31, 0], [0.31, 0], [0.31, 0.08], ["=0.2", "=Hh * 0.38"], ["=0.085", "=Hh"], ["=-0.085", "=Hh"], ["=-0.2", "=Hh * 0.38"], [-0.31, 0.08]],
        },
        {
            id: "jerseySeg", type: "mesh.extrude", output: false, when: "=kind == 'jersey'", outline: "@jerseyProfile", height: "=segL - 0.04", bevel: 0.015, bevelSegments: 1, smoothAngle: 20,
        },
        {
            id: "jerseys", type: "deform.noise", output: false, when: "=kind == 'jersey'", repeat: "=segs", mesh: "@jerseySeg",
            amount: "=damage * 0.03", frequency: 4, octaves: 2, seed: "=seed * 7 + index",
            rotate: [-90, "=(rand(index, 1) - 0.5) * 6 * damage", 0],
            at: ["=(rand(index, 2) - 0.5) * 0.12 * damage", 0, "=-L / 2 + (index + 1) * segL - 0.02"],
            region: "concrete",
        },
        {
            id: "stripes", type: "mesh.box", output: false, when: "=kind == 'jersey'", repeat: "=segs * 2",
            size: [0.012, 0.09, "=segL * 0.6"],
            at: ["=(index % 2 == 0 ? 1 : -1) * 0.155", "=Hh * 0.72", "=-L / 2 + floor(index / 2) * segL + segL / 2"],
            rotate: [0, 0, "=(index % 2 == 0 ? -1 : 1) * 9"],
            region: "stripe",
        },
        // --- Sandbags: squashed pillows, each row offset half a bag, the top row slumped ---
        { id: "bag", type: "mesh.sphere", output: false, radius: 0.5, segments: 10, rings: 6 },
        {
            id: "bags", type: "deform.noise", output: false, when: "=kind == 'sandbags'", repeat: "=bagsRow * rows", mesh: "@bag",
            amount: 0.04, frequency: 3, octaves: 1, seed: "=seed * 11 + index",
            scale: [0.34, "=0.2 + rand(index, 3) * 0.02", "=0.58 + rand(index, 4) * 0.04"],
            rotate: [0, "=(rand(index, 5) - 0.5) * 8", "=(rand(index, 6) - 0.5) * 4"],
            at: [
                "=(floor(index / bagsRow) % 2 == 0 ? -0.1 : 0.1) * (1 - floor(index / bagsRow) / rows)",
                "=0.08 + floor(index / bagsRow) * (Hh - 0.1) / rows - (floor(index / bagsRow) == rows - 1 && rand(index, 7) < damage ? 0.12 : 0)",
                "=-L / 2 + 0.27 + (index % bagsRow) * (L - 0.54) / max(1, bagsRow - 1) + (floor(index / bagsRow) % 2) * 0.13",
            ],
            region: "bags",
        },
        // --- Dry stone: rough blocks in courses, battered inward, capped with flat stones ---
        { id: "block", type: "mesh.box", output: false, size: [1, 1, 1], radius: 0.12, segments: 1 },
        {
            id: "stones", type: "deform.noise", output: false, when: "=kind == 'stone'", repeat: "=stonesRow * stoneRows", mesh: "@block",
            amount: 0.05, frequency: 2.6, octaves: 2, seed: "=seed * 13 + index",
            scale: ["=0.5 - floor(index / stonesRow) * 0.05", "=0.24 + rand(index, 8) * 0.06", "=0.44 + rand(index, 9) * 0.14"],
            rotate: ["=(rand(index, 10) - 0.5) * 8", "=(rand(index, 11) - 0.5) * 14", "=(rand(index, 12) - 0.5) * 8"],
            at: [
                "=(rand(index, 13) - 0.5) * 0.06",
                "=0.13 + floor(index / stonesRow) * (Hh - 0.12) / stoneRows - (rand(index, 14) < damage * 0.25 ? 0.08 : 0)",
                "=-L / 2 + 0.25 + (index % stonesRow) * (L - 0.5) / max(1, stonesRow - 1) + (floor(index / stonesRow) % 2) * 0.2",
            ],
            region: "stone",
        },
        {
            id: "caps", type: "deform.noise", output: false, when: "=kind == 'stone'", repeat: "=max(2, round(length / 0.7))", mesh: "@block",
            amount: 0.03, frequency: 3, octaves: 1, seed: "=seed * 17 + index",
            scale: [0.56, 0.1, "=0.62 + rand(index, 15) * 0.1"],
            rotate: [0, "=(rand(index, 16) - 0.5) * 10", "=(rand(index, 17) - 0.5) * 6"],
            at: [0, "=Hh + 0.02", "=-L / 2 + 0.33 + index * (L - 0.66) / max(1, round(length / 0.7) - 1)"],
            region: "cap",
        },
        { id: "barricade", type: "geo.join", meshes: ["@jerseys", "@stripes", "@bags", "@stones", "@caps"] },
    ],
    limits: { maxSize: 20, minSize: 0.5, maxTriangles: 40000 },
};

export default barricadeDef;
