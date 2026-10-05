import type { NodeDef, ObjectDef } from "../mesha_object";

// A city building for any rectangular footprint: offices, apartment blocks, shops, civic halls,
// warehouses, barracks. Front (entrance, shopfronts) toward +Z, width along X, depth along Z,
// standing on y = 0.
//
//      _________________________________   parapet and a two-step cornice; a stair house,
//     |=================================|  plant (fans on boxes) or a water tank on the roof
//     | |##| |##| |##| |##| |##| |##| | |  upper floors: piers between bays, spandrels
//     | |##| |##| |##| |##| |##| |##| | |  between floors, framed windows (head, sill bar,
//     |=================================|  mullion, transom) recessed into the glazed core,
//     |  SIGN   SIGN   SIGN   SIGN      |  a stone sill under each
//     | /___\ /___\ /___\ /___\         |  ground floor: shopfronts (stall riser, glazing,
//     | [   ] [   ] [ D ] [   ] [   ]   |  awning, fascia) or a lobby with a canopy, or
//     '---------------------------------'  blank; a plinth that the game can push into slopes
//
// The glazed core is one box set back by `recess`; the facade lattice stands in front of it, so
// a window costs a handful of boxes and a 30-storey tower stays well under the triangle limit.
// Every count follows the size (bays from `bayWidth`), so one definition fits any footprint.

type Side = { name: string; len: string; bays: string; open: string; face: string; at: (u: string, out: string) => [string, string]; rot: number };

const SIDES: Side[] = [
    { name: "Front", len: "width", bays: "bays", open: "openF", face: "depth / 2", at: (u, o) => [u, `depth / 2 - (${o})`], rot: 0 },
    { name: "Back", len: "width", bays: "bays", open: "openF", face: "depth / 2", at: (u, o) => [`-(${u})`, `-(depth / 2 - (${o}))`], rot: 180 },
    { name: "Right", len: "depth", bays: "baysD", open: "openS", face: "width / 2", at: (u, o) => [`width / 2 - (${o})`, `-(${u})`], rot: 90 },
    { name: "Left", len: "depth", bays: "baysD", open: "openS", face: "width / 2", at: (u, o) => [`-(width / 2 - (${o}))`, `${u}`], rot: -90 },
];

const e = (s: string) => `=${s}`;

/** The facade lattice and windows of one side's upper floors, and its ground-floor piers. */
function sideNodes(s: Side): NodeDef[] {
    const { len: L, bays: N, open: O } = s;
    // Along the side: pier i's center, window column c's center.
    const pierU = (i: string) => `-${L} / 2 + pier / 2 + (${i}) * (pier + ${O})`;
    const winU = (c: string) => `-${L} / 2 + pier + ${O} / 2 + (${c}) * (pier + ${O})`;
    const col = `index % ${N}`, row = `floor(index / ${N})`;
    const sill = (r: string) => `groundHeight + (${r}) * floorHeight + sillOff`;
    const xz = (u: string, out: string) => s.at(u, out).map(e);
    const at = (u: string, y: string, out: string) => { const [x, z] = xz(u, out); return [x, e(y), z]; };
    const rotate = [0, s.rot, 0];
    const id = (n: string) => `${n}${s.name}`;
    const windows = `${N} * upper`;
    return [
        // Piers, full height of the upper floors (standing proud of the spandrels when `pilasters`).
        { id: id("piers"), type: "mesh.box", when: "=upper > 0", repeat: e(`${N} + 1`), size: [e("pier"), e("H - groundHeight"), e("recess + pilaster")], segments: 1,
            rotate, at: at(pierU("index"), "groundHeight + (H - groundHeight) / 2", "(recess + pilaster) / 2 - pilaster"), region: "facade" },
        // Spandrels: from one floor's window heads to the next floor's sills.
        { id: id("spandrels"), type: "mesh.box", when: "=upper > 0", repeat: "=upper + 1", segments: 1,
            size: [e(L), e("(index == upper ? H : groundHeight + index * floorHeight + sillOff) - (index == 0 ? groundHeight : groundHeight + (index - 1) * floorHeight + sillOff + winH)"), e("recess")],
            rotate, at: at("0", "((index == upper ? H : groundHeight + index * floorHeight + sillOff) + (index == 0 ? groundHeight : groundHeight + (index - 1) * floorHeight + sillOff + winH)) / 2", "recess / 2"), region: "facade" },
        // Window frames: head and bottom bars, a mullion and a transom; a stone sill outside.
        { id: id("frameBars"), type: "mesh.box", when: "=upper > 0", repeat: e(`${windows} * 2`), segments: 1, size: [e(O), 0.07, 0.07],
            rotate, at: at(winU(`floor(index / 2) % ${N}`), `${sill(`floor(floor(index / 2) / ${N})`)} + (index % 2) * (winH - 0.07) + 0.035`, "recess - 0.035"), region: "frames" },
        { id: id("mullions"), type: "mesh.box", when: "=upper > 0 && mullions", repeat: e(windows), segments: 1, size: [0.06, e("winH"), 0.06],
            rotate, at: at(winU(col), `${sill(row)} + winH / 2`, "recess - 0.03"), region: "frames" },
        { id: id("transoms"), type: "mesh.box", when: "=upper > 0 && mullions", repeat: e(windows), segments: 1, size: [e(O), 0.05, 0.05],
            rotate, at: at(winU(col), `${sill(row)} + winH * 0.72`, "recess - 0.03"), region: "frames" },
        { id: id("sills"), type: "mesh.box", when: "=upper > 0 && sills", repeat: e(windows), segments: 1, size: [e(`${O} + 0.16`), 0.07, e("recess + 0.12")],
            rotate, at: at(winU(col), `${sill(row)} - 0.035`, "(recess + 0.12) / 2 - 0.12"), region: "trim" },
        // Hood mouldings over the windows (classical facades).
        { id: id("hoods"), type: "mesh.box", when: "=upper > 0 && ornament", repeat: e(windows), segments: 1, size: [e(`${O} + 0.3`), 0.14, 0.12],
            rotate, at: at(winU(col), `${sill(row)} + winH + 0.16`, "-0.06"), region: "trim" },
        // Ground floor piers (stone).
        { id: id("groundPiers"), type: "mesh.box", repeat: e(`${N} + 1`), segments: 1, size: [e("pier"), e("groundHeight"), e("recess + 0.08")],
            rotate, at: at(pierU("index"), "groundHeight / 2", "(recess + 0.08) / 2 - 0.08"), region: "trim" },
    ];
}

/** Ground-floor fronts on the +Z side: shopfronts or a lobby, the fascia and the awnings. */
function groundNodes(): NodeDef[] {
    const winU = (c: string) => `-width / 2 + pier + openF / 2 + (${c}) * (pier + openF)`;
    const glazed = "=ground != 'blank'";
    return [
        // Stall risers under the shop windows (not under the door).
        { id: "risers", type: "mesh.box", when: glazed, repeat: "=bays", segments: 1, size: ["=index == doorBay ? 0.001 : openF", 0.55, 0.12],
            at: [e(winU("index")), 0.275, "=depth / 2 - recess + 0.06"], region: "trim" },
        { id: "shopFrames", type: "mesh.box", when: glazed, repeat: "=bays * 2", segments: 1, size: ["=openF", 0.08, 0.08],
            at: [e(winU("floor(index / 2)")), "=index % 2 == 0 ? 0.59 : groundHeight - 0.95", "=depth / 2 - recess + 0.04"], region: "frames" },
        { id: "shopMullions", type: "mesh.box", when: glazed, repeat: "=bays", segments: 1, size: [0.06, "=groundHeight - 1.55", 0.06],
            at: [e(winU("index")), "=0.59 + (groundHeight - 1.55) / 2", "=depth / 2 - recess + 0.04"], region: "frames" },
        // The door: a dark leaf in a frame, in the middle bay (shops) or under the canopy (lobby).
        { id: "door", type: "mesh.box", when: "=ground != 'blank'", segments: 1, size: ["=min(openF * 0.8, ground == 'lobby' ? 2.6 : 1.3)", "=min(2.6, groundHeight - 1)", 0.08],
            at: [e(winU("doorBay")), "=min(2.6, groundHeight - 1) / 2", "=depth / 2 - recess + 0.05"], region: "door" },
        { id: "doorFrame", type: "mesh.box", when: "=ground != 'blank'", repeat: 2, segments: 1, size: [0.1, "=min(2.6, groundHeight - 1) + 0.1", 0.14],
            at: [`=${winU("doorBay")} + (index * 2 - 1) * (min(openF * 0.8, ground == 'lobby' ? 2.6 : 1.3) / 2 + 0.05)`, "=(min(2.6, groundHeight - 1) + 0.1) / 2", "=depth / 2 - recess + 0.07"], region: "frames" },
        { id: "step", type: "mesh.box", when: "=ground != 'blank'", segments: 1, size: ["=min(openF, 3.2)", 0.15, 0.6],
            at: [e(winU("doorBay")), 0.075, "=depth / 2 + 0.25"], region: "foundation" },
        // Fascia with a sign board over every shop.
        { id: "fascia", type: "mesh.box", when: "=ground == 'shops'", segments: 1, size: ["=width + 0.04", 0.7, "=recess + 0.16"],
            at: [0, "=groundHeight - 0.5", "=depth / 2 - recess / 2 + 0.06"], region: "fascia" },
        { id: "signs", type: "mesh.box", when: "=ground == 'shops' && signs", repeat: "=bays", segments: 1, size: ["=openF * 0.75", 0.42, 0.06],
            at: [e(winU("index")), "=groundHeight - 0.5", "=depth / 2 + 0.2"], region: "signs" },
        // Awnings: canvas slopes over the shop windows.
        { id: "awnings", type: "mesh.box", when: `=ground == 'shops' && awnings`, repeat: "=bays", segments: 1, size: ["=index == doorBay ? 0.001 : openF * 0.96", 0.05, 1.3],
            rotate: [22, 0, 0], at: [e(winU("index")), "=groundHeight - 1.15", "=depth / 2 + 0.55"], region: "awning" },
        { id: "awningValances", type: "mesh.box", when: `=ground == 'shops' && awnings`, repeat: "=bays", segments: 1, size: ["=index == doorBay ? 0.001 : openF * 0.96", 0.22, 0.03],
            at: [e(winU("index")), "=groundHeight - 1.5", "=depth / 2 + 1.16"], region: "awning" },
        // Lobby: a flat canopy on two posts over the door.
        { id: "canopy", type: "mesh.box", when: "=ground == 'lobby'", segments: 1, size: ["=min(width - 1, 5.5)", 0.22, 2.4],
            at: [e(winU("doorBay")), "=min(groundHeight - 0.4, 3.4)", "=depth / 2 + 1.1"], region: "frames" },
        { id: "canopyPosts", type: "mesh.cylinder", when: "=ground == 'lobby'", repeat: 2, radius: 0.07, height: "=min(groundHeight - 0.4, 3.4) - 0.11", segments: 12,
            at: [`=${winU("doorBay")} + (index * 2 - 1) * (min(width - 1, 5.5) / 2 - 0.3)`, 0, "=depth / 2 + 2.1"], region: "frames" },
        // Blank ground floors (warehouses, barracks): a wall with a roller door.
        { id: "blankWall", type: "mesh.box", when: "=ground == 'blank'", segments: 1, size: ["=width - 0.02", "=groundHeight", "=recess"],
            at: [0, "=groundHeight / 2", "=depth / 2 - recess / 2"], region: "facade" },
        { id: "rollerDoor", type: "mesh.box", when: "=ground == 'blank' && width > 6", segments: 1, size: ["=min(4.4, width * 0.35)", "=min(3.8, groundHeight - 0.4)", 0.06],
            at: [0, "=min(3.8, groundHeight - 0.4) / 2", "=depth / 2 + 0.03"], region: "door" },
    ];
}

const cityBlock: ObjectDef = {
    id: "architecture.city_block",
    name: "City Building",
    category: "Architecture",
    tags: ["building", "office", "apartment", "apartments", "tenement", "block", "shop", "shops", "storefront", "tower", "high-rise", "mid-rise", "city", "urban", "street", "facade", "commercial", "civic", "warehouse", "barracks"],
    description: "A city building for any rectangular footprint: storeys of framed windows between piers and spandrels, shopfronts with awnings or a lobby on the ground floor, a cornice and parapet, and plant, a water tank or a stair house on the roof.",
    featured: ["width", "depth", "floors", "bayWidth", "windowWidth", "ground", "rooftop", "facadeFinish", "trimFinish", "glassFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "facade", label: "Facade" },
        { id: "ground", label: "Ground floor" },
        { id: "top", label: "Roof line" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "width", label: "Width", type: "number", default: 18, min: 4, max: 90, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 14, min: 4, max: 90, unit: "m", group: "size" },
        { id: "floors", label: "Storeys", type: "int", default: 5, min: 1, max: 40, group: "size" },
        { id: "floorHeight", label: "Storey height", type: "number", default: 3.3, min: 2.8, max: 4.6, unit: "m", group: "size" },
        { id: "groundHeight", label: "Ground storey", type: "number", default: 4.4, min: 3.2, max: 7, unit: "m", group: "size" },
        { id: "bayWidth", label: "Bay width", type: "number", default: 3.4, min: 2, max: 7, unit: "m", group: "facade", description: "Window bays follow the size: one per this many meters." },
        { id: "windowWidth", label: "Window width", type: "number", default: 0.6, min: 0.25, max: 0.9, group: "facade", description: "Share of each bay that is window." },
        { id: "windowHeight", label: "Window height", type: "number", default: 0.55, min: 0.3, max: 0.85, group: "facade", description: "Share of each storey that is window." },
        { id: "recess", label: "Window recess", type: "number", default: 0.22, min: 0.08, max: 0.5, unit: "m", group: "facade" },
        { id: "pilaster", label: "Pilasters", type: "number", default: 0.06, min: 0, max: 0.4, unit: "m", group: "facade", description: "How far the piers stand proud of the wall." },
        { id: "mullions", label: "Mullions and transoms", type: "bool", default: true, group: "facade" },
        { id: "sills", label: "Stone sills", type: "bool", default: true, group: "facade" },
        { id: "ornament", label: "Hood mouldings", type: "bool", default: false, group: "facade" },
        { id: "ground", label: "Ground floor", type: "enum", default: "shops", options: ["shops", "lobby", "blank"], optionLabels: ["Shopfronts", "Lobby", "Blank wall"], group: "ground" },
        { id: "awnings", label: "Awnings", type: "bool", default: true, group: "ground", visibleIf: "=ground == 'shops'" },
        { id: "signs", label: "Sign boards", type: "bool", default: true, group: "ground", visibleIf: "=ground == 'shops'" },
        { id: "cornice", label: "Cornice", type: "bool", default: true, group: "top" },
        { id: "parapet", label: "Parapet height", type: "number", default: 0.9, min: 0, max: 1.6, unit: "m", group: "top" },
        { id: "rooftop", label: "On the roof", type: "enum", default: "plant", options: ["plant", "tank", "stair", "none"], optionLabels: ["Plant", "Water tank", "Stair house", "Nothing"], group: "top" },
        { id: "facadeFinish", label: "Facade", type: "material", default: "masonry.brick", materials: ["masonry", "stone", "paint", "metal", "composite"], group: "materials" },
        { id: "trimFinish", label: "Trim and ground floor", type: "material", default: "stone.sandstone", materials: ["stone", "masonry", "paint", "metal", "composite"], group: "materials" },
        { id: "glassFinish", label: "Glazing", type: "material", default: "glass.windowTinted", materials: ["glass"], group: "materials" },
        { id: "frameFinish", label: "Window frames", type: "material", default: "paint.black", materials: ["paint", "metal", "wood"], group: "materials" },
        { id: "fasciaFinish", label: "Fascia", type: "material", default: "paint.brunswick", materials: ["paint", "metal", "wood"], group: "materials", visibleIf: "=ground == 'shops'" },
        { id: "awningFinish", label: "Awnings", type: "material", default: "fabric.rust", materials: ["fabric", "paint"], group: "materials", visibleIf: "=ground == 'shops' && awnings" },
        { id: "roofFinish", label: "Roof", type: "material", default: "roofing.seam", materials: ["roofing", "masonry", "stone", "metal"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 7, group: "materials", variation: 0 },
    ],
    derived: {
        bays: "=max(1, round(width / bayWidth))",
        baysD: "=max(1, round(depth / bayWidth))",
        upper: "=max(0, floors - 1)",
        H: "=groundHeight + upper * floorHeight",
        pier: "=clamp(min(width / bays, depth / baysD) * (1 - windowWidth), 0.3, 2.4)",
        openF: "=max(0.3, (width - pier * (bays + 1)) / bays)",
        openS: "=max(0.3, (depth - pier * (baysD + 1)) / baysD)",
        winH: "=floorHeight * windowHeight",
        sillOff: "=(floorHeight - winH) * 0.42",
        doorBay: "=floor(bays / 2)",
        roofY: "=H + 0.3",
        corniceOut: "=cornice ? 0.35 : 0.08",
    },
    rules: [
        { check: "=pier * (bays + 1) < width", message: "The bays are too narrow for their piers: widen the bays or the windows." },
    ],
    regions: {
        facade: { label: "Facade", material: "=facadeFinish" },
        trim: { label: "Trim", material: "=trimFinish" },
        glass: { label: "Glazing", material: "=glassFinish" },
        frames: { label: "Window frames", material: "=frameFinish" },
        foundation: { label: "Plinth", material: "stone.granite" },
        fascia: { label: "Fascia", material: "=fasciaFinish" },
        signs: { label: "Sign boards", material: "paint.cream" },
        awning: { label: "Awnings", material: "=awningFinish" },
        door: { label: "Doors", material: "metal.black" },
        roof: { label: "Roof", material: "=roofFinish" },
        plant: { label: "Roof plant", material: "metal.zinc" },
    },
    presets: [
        { name: "Brick tenement", values: { floors: 5, facadeFinish: "masonry.brick", trimFinish: "stone.sandstone", ornament: true, ground: "shops", rooftop: "tank", frameFinish: "paint.white", fasciaFinish: "paint.brunswick", awningFinish: "fabric.rust", glassFinish: "glass.window" } },
        { name: "Stucco apartments", values: { floors: 4, facadeFinish: "masonry.stucco", trimFinish: "paint.white", pilaster: 0, ground: "shops", rooftop: "stair", frameFinish: "paint.black", awningFinish: "fabric.navy", fasciaFinish: "paint.navy", glassFinish: "glass.window" } },
        { name: "Concrete block", values: { floors: 8, bayWidth: 3.2, windowWidth: 0.5, windowHeight: 0.5, facadeFinish: "masonry.concrete", trimFinish: "masonry.darkConcrete", ornament: false, mullions: false, cornice: false, parapet: 1.1, ground: "lobby", rooftop: "plant", frameFinish: "metal.aluminum", glassFinish: "glass.windowTinted" } },
        { name: "Glass office", values: { floors: 14, floorHeight: 3.7, groundHeight: 5.2, bayWidth: 3, windowWidth: 0.86, windowHeight: 0.78, recess: 0.14, pilaster: 0.18, sills: false, cornice: false, parapet: 1.2, facadeFinish: "metal.black", trimFinish: "stone.granite", ground: "lobby", rooftop: "plant", frameFinish: "metal.black", glassFinish: "glass.windowTinted" } },
        { name: "Civic stone", values: { floors: 4, floorHeight: 4.2, groundHeight: 5.4, bayWidth: 4.2, windowWidth: 0.45, windowHeight: 0.62, pilaster: 0.24, ornament: true, facadeFinish: "stone.sandstone", trimFinish: "stone.marble", ground: "lobby", rooftop: "none", parapet: 1.3, frameFinish: "paint.white", glassFinish: "glass.window" } },
        { name: "Warehouse", values: { floors: 2, floorHeight: 4.5, groundHeight: 6, bayWidth: 6, windowWidth: 0.45, windowHeight: 0.35, pilaster: 0.2, mullions: false, sills: false, cornice: false, parapet: 0.5, facadeFinish: "metal.corrugated", trimFinish: "masonry.darkConcrete", ground: "blank", rooftop: "plant", frameFinish: "metal.black", glassFinish: "glass.fibreglass" } },
        { name: "Barracks", values: { floors: 2, floorHeight: 3.2, groundHeight: 3.6, bayWidth: 3.6, windowWidth: 0.35, windowHeight: 0.4, pilaster: 0.12, mullions: false, cornice: false, parapet: 0.7, facadeFinish: "masonry.darkConcrete", trimFinish: "masonry.concrete", ground: "lobby", rooftop: "plant", frameFinish: "metal.black", glassFinish: "glass.windowTinted", roofFinish: "roofing.seam" } },
    ],
    nodes: [
        // The glazed core: what you see through every window opening.
        { id: "core", type: "mesh.box", segments: 1, size: ["=width - recess * 2", "=H", "=depth - recess * 2"], at: [0, "=H / 2", 0], region: "glass" },
        // Plinth: the shader pushes its bottom into sloping ground.
        { id: "plinth", type: "mesh.box", segments: 1, size: ["=width + 0.12", 0.4, "=depth + 0.12"], at: [0, 0.2, 0], region: "foundation" },
        ...SIDES.flatMap(sideNodes),
        ...groundNodes(),
        // Side and back ground floors: shop windows only face the street.
        { id: "groundWalls", type: "mesh.box", repeat: 3, segments: 1, size: ["=index == 0 ? width - 0.02 : depth - 0.02", "=groundHeight - 0.4", "=recess * 0.5"],
            rotate: [0, "=index == 0 ? 180 : index == 1 ? 90 : -90", 0],
            at: ["=index == 0 ? 0 : (index == 1 ? 1 : -1) * (width / 2 - recess * 0.75)", "=0.4 + (groundHeight - 0.4) / 2", "=index == 0 ? -(depth / 2 - recess * 0.75) : 0"], region: "trim" },
        // String course over the ground floor.
        { id: "stringCourse", type: "mesh.box", segments: 1, size: ["=width + 0.2", 0.26, "=depth + 0.2"], at: [0, "=groundHeight + 0.13", 0], region: "trim" },
        // Roof slab, cornice (two steps) and parapet.
        { id: "roofSlab", type: "mesh.box", segments: 1, size: ["=width", 0.3, "=depth"], at: [0, "=H + 0.15", 0], region: "roof" },
        { id: "corniceLow", type: "mesh.box", when: "=cornice", segments: 1, size: ["=width + 0.3", 0.22, "=depth + 0.3"], at: [0, "=H - 0.05", 0], region: "trim" },
        { id: "corniceTop", type: "mesh.box", segments: 1, size: ["=width + corniceOut * 2", 0.26, "=depth + corniceOut * 2"], at: [0, "=H + 0.17", 0], region: "trim" },
        { id: "parapets", type: "mesh.box", when: "=parapet > 0", repeat: 4, segments: 1,
            size: ["=index < 2 ? width : 0.25", "=parapet", "=index < 2 ? 0.25 : depth - 0.5"],
            at: ["=index < 2 ? 0 : (index == 2 ? 1 : -1) * (width / 2 - 0.125)", "=roofY + parapet / 2", "=index < 2 ? (index == 0 ? 1 : -1) * (depth / 2 - 0.125) : 0"], region: "facade" },
        { id: "copings", type: "mesh.box", when: "=parapet > 0", repeat: 4, segments: 1,
            size: ["=index < 2 ? width + 0.08 : 0.33", 0.08, "=index < 2 ? 0.33 : depth"],
            at: ["=index < 2 ? 0 : (index == 2 ? 1 : -1) * (width / 2 - 0.125)", "=roofY + parapet + 0.04", "=index < 2 ? (index == 0 ? 1 : -1) * (depth / 2 - 0.125) : 0"], region: "trim" },
        // Roof: a stair house, plant (boxes with fans), a water tank on legs, a mast.
        { id: "stairHouse", type: "mesh.box", when: "=rooftop != 'none' && width > 7 && depth > 7", segments: 1, size: [2.6, 2.7, 3.6],
            at: ["=(rand(1) - 0.5) * (width - 6)", "=roofY + 1.35", "=(rand(2) - 0.5) * (depth - 6)"], region: "facade" },
        { id: "stairDoor", type: "mesh.box", when: "=rooftop != 'none' && width > 7 && depth > 7", segments: 1, size: [0.9, 2, 0.05],
            at: ["=(rand(1) - 0.5) * (width - 6)", "=roofY + 1", "=(rand(2) - 0.5) * (depth - 6) + 1.81"], region: "door" },
        { id: "plantBoxes", type: "mesh.box", when: "=rooftop == 'plant' && width > 6 && depth > 6", repeat: "=clamp(floor(width * depth / 160), 1, 6)", segments: 1, radius: 0.04,
            size: [1.6, 1.1, 2.2], at: ["=(rand(index, 11) - 0.5) * (width - 4)", "=roofY + 0.55", "=(rand(index, 12) - 0.5) * (depth - 4)"], region: "plant" },
        { id: "plantFans", type: "mesh.cylinder", when: "=rooftop == 'plant' && width > 6 && depth > 6", repeat: "=clamp(floor(width * depth / 160), 1, 6)", radius: 0.55, height: 0.18, segments: 20, bevel: 0.03,
            at: ["=(rand(index, 11) - 0.5) * (width - 4)", "=roofY + 1.1", "=(rand(index, 12) - 0.5) * (depth - 4) + 0.35"], region: "frames" },
        { id: "tank", type: "mesh.cylinder", when: "=rooftop == 'tank' && width > 6 && depth > 6", radius: 1.25, height: 2.4, segments: 24, bevel: 0.05,
            at: ["=(rand(3) - 0.5) * (width - 5)", "=roofY + 2", "=(rand(4) - 0.5) * (depth - 5)"], region: "plant" },
        { id: "tankRoof", type: "mesh.cone", when: "=rooftop == 'tank' && width > 6 && depth > 6", bottomRadius: 1.35, topRadius: 0.1, height: 0.7, segments: 24,
            at: ["=(rand(3) - 0.5) * (width - 5)", "=roofY + 4.4", "=(rand(4) - 0.5) * (depth - 5)"], region: "roof" },
        { id: "tankLegs", type: "mesh.box", when: "=rooftop == 'tank' && width > 6 && depth > 6", repeat: 4, segments: 1, size: [0.14, 2, 0.14],
            at: ["=(rand(3) - 0.5) * (width - 5) + (index % 2 * 2 - 1) * 0.85", "=roofY + 1", "=(rand(4) - 0.5) * (depth - 5) + (floor(index / 2) * 2 - 1) * 0.85"], region: "frames" },
        { id: "mast", type: "mesh.cylinder", when: "=floors >= 8", radius: 0.06, height: "=3 + floors * 0.15", segments: 8,
            at: ["=(rand(5) - 0.5) * width * 0.5", "=roofY", "=(rand(6) - 0.5) * depth * 0.5"], region: "frames" },
    ],
    limits: { maxSize: 200, minSize: 3, maxTriangles: 200000 },
};

export default cityBlock;
