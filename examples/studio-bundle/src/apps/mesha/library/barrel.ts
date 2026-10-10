import type { ObjectDef } from "../mesha_object";

// Steel drums, burn barrels and plastic barrels, alone or in a huddle. Each barrel is turned from
// one closed profile (rolled hoops, chimes at both ends; a burn barrel is open at the top with its
// fire showing); Dents push every copy about differently, and a share of them lie tipped over.
// Copy 0 stands at the origin, the rest round it.

const P = (r: string, y: string): [string, string] => [`=${r}`, `=${y}`];

export const barrelDef: ObjectDef = {
    id: "street.barrel",
    name: "Drum & Barrel",
    category: "Street",
    tags: ["barrel", "drum", "oil drum", "steel drum", "burn barrel", "fire barrel", "plastic barrel", "hazard", "toxic", "waste", "rust", "post-apocalyptic", "wasteland", "industrial", "prop"],
    description: "Rusted 200-litre steel drums, burn barrels with a fire inside, or plastic barrels, one or a huddle of up to seven, dented and some tipped over.",
    featured: ["kind", "count", "tipped", "dents", "drumFinish"],
    groups: [
        { id: "barrel", label: "Barrel" },
        { id: "group", label: "Huddle" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "kind", label: "Kind", type: "enum", default: "drum", options: ["drum", "burn", "plastic"], optionLabels: ["Steel drum", "Burn barrel", "Plastic barrel"], group: "barrel" },
        { id: "radius", label: "Radius", type: "number", default: 0.29, min: 0.2, max: 0.4, unit: "m", group: "barrel" },
        { id: "height", label: "Height", type: "number", default: 0.88, min: 0.5, max: 1.1, unit: "m", group: "barrel" },
        { id: "dents", label: "Dents", type: "number", default: 0.4, min: 0, max: 1, group: "barrel" },
        { id: "band", label: "Hazard band", type: "bool", default: true, group: "barrel", visibleIf: "=kind == 'drum'" },
        { id: "fire", label: "Fire", type: "bool", default: true, group: "barrel", visibleIf: "=kind == 'burn'" },
        { id: "count", label: "Barrels", type: "int", default: 1, min: 1, max: 7, group: "group" },
        { id: "tipped", label: "Tipped over", type: "number", default: 0.25, min: 0, max: 1, group: "group", visibleIf: "=count > 1", description: "Share of the huddle lying on its side (never the first)." },
        { id: "spread", label: "Spread", type: "number", default: 1, min: 0.8, max: 2, group: "group", visibleIf: "=count > 1" },
        { id: "drumFinish", label: "Barrel", type: "material", default: "metal.rustRed", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "metal.rustDark", "paint.navy", "paint.teal", "paint.black", "plastic.red", "plastic.black"], group: "materials" },
        { id: "bandFinish", label: "Band", type: "material", default: "paint.signal", materials: ["paint", "metal.rustYellow"], group: "materials", visibleIf: "=kind == 'drum' && band" },
        { id: "fireFinish", label: "Fire", type: "material", default: "glow.amber", materials: ["glow"], group: "materials", visibleIf: "=kind == 'burn' && fire" },
        { id: "seed", label: "Seed", type: "seed", default: 5, group: "materials", variation: 0 },
    ],
    derived: {
        R: "=radius", Hh: "=height", plastic: "=kind == 'plastic'", burn: "=kind == 'burn'",
        hoop: "=kind == 'plastic' ? 0.012 : 0.016",
    },
    regions: {
        drum: { label: "Barrel", material: "=drumFinish" },
        band: { label: "Band", material: "=bandFinish" },
        inside: { label: "Inside", material: "metal.black" },
        ash: { label: "Ash and coals", material: "ground.mud" },
        fire: { label: "Fire", material: "=fireFinish" },
        holes: { label: "Air holes", material: "=burn && fire ? fireFinish : 'metal.black'" },
    },
    presets: [
        { name: "Rusted drum", values: {} },
        { name: "Burn barrel", values: { kind: "burn", drumFinish: "metal.rustDark", dents: 0.6, seed: 2 } },
        { name: "Toxic stack", values: { count: 6, tipped: 0.35, drumFinish: "metal.rustYellow", bandFinish: "paint.black", dents: 0.5, seed: 9 } },
        { name: "Plastic barrels", values: { kind: "plastic", count: 3, tipped: 0.3, drumFinish: "paint.navy", radius: 0.3, height: 0.92, dents: 0.15, seed: 4 } },
        { name: "Scavenger camp fire", values: { kind: "burn", count: 3, tipped: 0, spread: 1.6, drumFinish: "metal.rust", seed: 12 } },
    ],
    nodes: [
        // One barrel, standing on its origin. A burn barrel's top is open: the profile turns inside.
        { id: "profile", type: "curve.points", output: false, points: { if: "=burn", then: [
            [0, 0], P("R * 0.97", "0"), P("R", "0.025"), P("R", "Hh * 0.33 - 0.02"), P("R + hoop", "Hh * 0.33"), P("R", "Hh * 0.33 + 0.02"),
            P("R", "Hh * 0.66 - 0.02"), P("R + hoop", "Hh * 0.66"), P("R", "Hh * 0.66 + 0.02"), P("R", "Hh - 0.02"), P("R + 0.012", "Hh"), P("R - 0.012", "Hh"), P("R - 0.012", "0.04"), [0, 0.04],
        ], else: [
            [0, 0], P("R * (plastic ? 0.9 : 0.97)", "0"), P("R", "plastic ? 0.06 : 0.025"), P("R", "Hh * 0.33 - 0.02"), P("R + hoop", "Hh * 0.33"), P("R", "Hh * 0.33 + 0.02"),
            P("R", "Hh * 0.66 - 0.02"), P("R + hoop", "Hh * 0.66"), P("R", "Hh * 0.66 + 0.02"), P("R", "Hh - (plastic ? 0.06 : 0.025)"), P("R * (plastic ? 0.9 : 0.98)", "Hh"), [0, "=Hh"],
        ] } },
        { id: "shell", type: "mesh.lathe", output: false, profile: "@profile", segments: 28, smoothAngle: 50, region: "drum" },
        { id: "bandRing", type: "mesh.lathe", output: false, when: "=kind == 'drum' && band", segments: 28, region: "band",
            profile: [P("R + 0.003", "Hh * 0.42"), P("R + 0.003", "Hh * 0.56"), P("R - 0.01", "Hh * 0.56"), P("R - 0.01", "Hh * 0.42"), P("R + 0.003", "Hh * 0.42")] },
        { id: "bungs", type: "mesh.cylinder", output: false, when: "=!burn", repeat: 2, radius: "=index == 0 ? 0.03 : 0.02", height: 0.015, segments: 10,
            at: ["=R * (index == 0 ? 0.55 : -0.6)", "=Hh", "=R * 0.2"], region: "drum" },
        { id: "coals", type: "mesh.cylinder", output: false, when: "=burn", radius: "=R - 0.02", height: 0.02, segments: 24, at: [0, "=Hh * 0.82", 0], region: "ash" },
        { id: "flames", type: "mesh.cone", output: false, when: "=burn && fire", repeat: 4, bottomRadius: "=R * (0.42 - index * 0.06)", topRadius: 0.01, height: "=0.25 + index * 0.07", segments: 7,
            rotate: ["=(rand(index, 4) - 0.5) * 18", 0, "=(rand(index, 5) - 0.5) * 18"],
            at: ["=(rand(index, 6) - 0.5) * R * 0.6", "=Hh * 0.82", "=(rand(index, 7) - 0.5) * R * 0.6"], region: "fire" },
        { id: "airHoles", type: "mesh.box", output: false, when: "=burn", repeat: 10, size: [0.07, 0.07, 0.02], rotate: [0, "=90 - index * 36", 45],
            at: ["=(R + 0.002) * cos(rad(index * 36))", "=Hh * (index % 2 == 0 ? 0.18 : 0.24)", "=(R + 0.002) * sin(rad(index * 36))"], region: "holes" },
        { id: "barrel", type: "geo.join", output: false, meshes: ["@shell", "@bandRing", "@bungs", "@coals", "@flames", "@airHoles"] },
        // The huddle: dented copies, some tipped onto their sides.
        {
            id: "huddle", type: "deform.noise", output: false, repeat: "=count", mesh: "@barrel", amount: "=dents * R * 0.06", frequency: "=3.2 / R", octaves: 2, seed: "=seed * 13 + index",
            rotate: ["=index > 0 && rand(index, 8) < tipped ? 90 : (rand(index, 9) - 0.5) * 4", "=rand(index, 10) * 360", 0],
            at: [
                "=index == 0 ? 0 : cos(rad(index * 137.5 + rand(index, 11) * 30)) * R * spread * (2.1 + 1.2 * floor((index - 1) / 4))",
                "=index > 0 && rand(index, 8) < tipped ? R : 0",
                "=index == 0 ? 0 : sin(rad(index * 137.5 + rand(index, 11) * 30)) * R * spread * (2.1 + 1.2 * floor((index - 1) / 4))",
            ],
        },
        { id: "settled", type: "deform.clamp", mesh: "@huddle", min: 0 },
    ],
    limits: { maxSize: 6, minSize: 0.4, maxTriangles: 30000 },
};

export default barrelDef;
