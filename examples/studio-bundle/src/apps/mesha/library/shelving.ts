import type { ObjectDef } from "../mesha_object";

/**
 * Freestanding shelving, from a bedside bookcase to a warehouse rack: a panelled bookcase (sides,
 * dividers, back, plinth and cornice) or an open frame of posts with cross braces and lipped
 * shelves. Books are household.book children in four cover colours, packed along each shelf at
 * random heights and gaps, always shorter than the clearance above them. Faces +Z.
 */
const shelving: ObjectDef = {
    id: "furniture.shelving",
    name: "Bookshelf & Shelving",
    category: "Furniture",
    tags: ["bookshelf", "bookcase", "shelves", "shelving", "rack", "storage rack", "library", "shop shelf", "industrial shelving"],
    description: "Panelled bookcase or open-frame rack, with optional books on the shelves.",
    featured: ["width", "height", "depth", "bays", "shelves", "construction", "books", "fill", "frameFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "build", label: "Construction" },
        { id: "contents", label: "Books" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "width", label: "Width", type: "number", default: 0.9, min: 0.3, max: 3.6, unit: "m", group: "size" },
        { id: "height", label: "Height", type: "number", default: 1.8, min: 0.4, max: 2.6, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 0.32, min: 0.18, max: 0.8, unit: "m", group: "size" },
        { id: "bays", label: "Bays", type: "int", default: 1, min: 1, max: "=clamp(floor(width / 0.28), 1, 6)", group: "build" },
        { id: "shelves", label: "Shelves", type: "int", default: 4, min: 1, max: "=clamp(floor((height - 0.1) / 0.2), 1, 10)", group: "build", description: "Shelf levels, counting the bottom one." },
        { id: "construction", label: "Construction", type: "enum", default: "bookcase", options: ["bookcase", "frame"], optionLabels: ["Panelled bookcase", "Open frame rack"], group: "build" },
        { id: "boardThickness", label: "Board thickness", type: "number", default: 0.022, min: 0.012, max: 0.045, unit: "m", decimals: 3, group: "build" },
        { id: "back", label: "Back panel", type: "bool", default: true, group: "build", visibleIf: "=construction == 'bookcase'" },
        { id: "cornice", label: "Cornice", type: "bool", default: true, group: "build", visibleIf: "=construction == 'bookcase'" },
        { id: "plinthHeight", label: "Plinth", type: "number", default: 0.08, min: 0, max: 0.2, unit: "m", group: "build", visibleIf: "=construction == 'bookcase'" },
        { id: "braces", label: "Cross braces", type: "bool", default: true, group: "build", visibleIf: "=construction == 'frame'" },
        { id: "lowShelf", label: "Bottom shelf height", type: "number", default: 0.12, min: 0.03, max: 0.35, unit: "m", group: "build", visibleIf: "=construction == 'frame'" },
        { id: "books", label: "Books", type: "bool", default: true, group: "contents" },
        { id: "fill", label: "Fill", type: "number", default: 0.75, min: 0.1, max: 1, group: "contents", visibleIf: "=books" },
        { id: "bookHeight", label: "Book height", type: "number", default: 0.24, min: 0.12, max: 0.4, unit: "m", group: "contents", visibleIf: "=books", description: "The tallest books; each shelf trims them to fit." },
        { id: "frameFinish", label: "Frame", type: "material", default: "wood.walnut", materials: ["wood", "paint", "metal.black", "metal.steel", "metal.zinc", "metal.rust"], group: "materials" },
        { id: "shelfFinish", label: "Shelves", type: "material", default: "wood.walnut", materials: ["wood", "paint", "metal.steel", "metal.zinc", "glass.clear"], group: "materials" },
        { id: "cover1", label: "Covers 1", type: "material", default: "cloth.red", materials: ["cloth", "leather", "paint", "paper.kraft", "paper.white"], group: "materials", visibleIf: "=books" },
        { id: "cover2", label: "Covers 2", type: "material", default: "cloth.green", materials: ["cloth", "leather", "paint", "paper.kraft", "paper.white"], group: "materials", visibleIf: "=books" },
        { id: "cover3", label: "Covers 3", type: "material", default: "cloth.blue", materials: ["cloth", "leather", "paint", "paper.kraft", "paper.white"], group: "materials", visibleIf: "=books" },
        { id: "cover4", label: "Covers 4", type: "material", default: "paper.white", materials: ["cloth", "leather", "paint", "paper.kraft", "paper.white"], group: "materials", visibleIf: "=books" },
        { id: "seed", label: "Seed", type: "seed", default: 11, group: "materials" },
    ],
    derived: {
        bd: "=boardThickness",
        isCase: "=construction == 'bookcase'",
        // Frame: square posts at every bay line.
        post: "=clamp(width * 0.02, 0.025, 0.045)",
        side: "=isCase ? bd : post",
        bayW: "=(width - 2 * side - (bays - 1) * side) / bays",
        y0: "=isCase ? plinthHeight : lowShelf",
        top: "=isCase ? height - (cornice ? 0.05 : 0) : height - 0.02",
        // Shelf levels from the bottom board to the last one below the top.
        pitch: "=(top - bd - y0) / shelves",
        clear: "=pitch - bd",
        sd: "=isCase ? depth - (back ? 0.008 : 0) - 0.004 : depth - 0.004",
        sz: "=isCase && back ? 0.004 : 0",
        // Books: a slot every `bp` along each bay, trimmed to the clearance and the shelf depth.
        bp: 0.034,
        slots: "=max(1, floor((bayW - 0.02) / bp))",
        bh: "=min(bookHeight, clear - 0.015)",
        bScaleZ: "=min(1, (sd - 0.02) / 0.17)",
        bookCount: "=books && bh > 0.08 ? bays * shelves * slots : 0",
    },
    rules: [
        { check: "=clear >= 0.14", message: "The shelves are too close together to use." },
        { check: "=bayW <= (isCase ? 1.0 : 1.4) + bd * 10", message: "Shelves that long would sag: add bays." },
        { check: "=height / depth < 9 || height < 1", message: "Too tall for its depth to stand without fixing to a wall." },
        { check: "=bayW >= 0.2", message: "The bays are too narrow." },
    ],
    regions: {
        frame: { label: "Frame", material: "=frameFinish" },
        shelf: { label: "Shelves", material: "=shelfFinish" },
        cover: { label: "Covers 1", material: "=cover1" },
        cover2: { label: "Covers 2", material: "=cover2" },
        cover3: { label: "Covers 3", material: "=cover3" },
        cover4: { label: "Covers 4", material: "=cover4" },
        pages: { label: "Pages", material: "paper.page" },
        label: { label: "Spine labels", material: "metal.gold" },
    },
    presets: [
        { name: "Library bookcase", values: { width: 2.4, height: 2.2, depth: 0.34, bays: 3, shelves: 6, construction: "bookcase", boardThickness: 0.028, back: true, cornice: true, plinthHeight: 0.1, books: true, fill: 0.85, frameFinish: "wood.walnut", shelfFinish: "wood.walnut", cover1: "leather.brown", cover2: "cloth.red", cover3: "cloth.green", cover4: "leather.black" } },
        { name: "Bedside shelf", values: { width: 0.45, height: 0.75, depth: 0.28, bays: 1, shelves: 3, construction: "bookcase", boardThickness: 0.018, back: true, cornice: false, plinthHeight: 0.03, books: true, fill: 0.6, frameFinish: "paint.white", shelfFinish: "paint.white", cover1: "paint.terracotta", cover2: "paper.white", cover3: "cloth.blue", cover4: "paint.sage" } },
        { name: "Industrial rack", values: { width: 1.8, height: 2.0, depth: 0.5, bays: 2, shelves: 5, construction: "frame", boardThickness: 0.025, braces: true, lowShelf: 0.15, books: false, frameFinish: "metal.black", shelfFinish: "wood.ash" } },
        { name: "Shop shelving", values: { width: 1.2, height: 1.6, depth: 0.42, bays: 1, shelves: 4, construction: "frame", boardThickness: 0.02, braces: false, lowShelf: 0.1, books: false, frameFinish: "metal.zinc", shelfFinish: "metal.zinc" } },
        { name: "Workshop rack", values: { width: 1.5, height: 1.85, depth: 0.6, bays: 1, shelves: 4, construction: "frame", boardThickness: 0.03, braces: true, lowShelf: 0.2, books: false, frameFinish: "metal.rust", shelfFinish: "wood.weathered" } },
    ],
    nodes: [
        // --- Panelled bookcase ----------------------------------------------------------------------
        { id: "caseSides", type: "mesh.box", when: "=isCase", repeat: 2, size: ["=bd", "=top", "=depth"], radius: 0.0015, at: ["=(index * 2 - 1) * (width / 2 - bd / 2)", "=top / 2", 0], region: "frame" },
        { id: "caseTop", type: "mesh.box", when: "=isCase", size: ["=width - 2 * bd", "=bd", "=depth"], at: [0, "=top - bd / 2", 0], region: "frame" },
        { id: "caseDividers", type: "mesh.box", when: "=isCase", repeat: "=bays - 1", size: ["=bd", "=top - y0 - bd", "=sd"], at: ["=-width / 2 + side + (index + 1) * (bayW + side) - side / 2", "=y0 + (top - y0 - bd) / 2", "=sz"], region: "frame" },
        { id: "caseBack", type: "mesh.box", when: "=isCase && back", size: ["=width - 2 * bd", "=top - y0 - bd", 0.008], at: [0, "=y0 + (top - y0 - bd) / 2", "=-depth / 2 + 0.004"], region: "frame" },
        { id: "plinth", type: "mesh.box", when: "=isCase && plinthHeight > 0", size: ["=width - 2 * bd", "=plinthHeight", "=bd"], at: [0, "=plinthHeight / 2", "=depth / 2 - bd / 2 - 0.006"], region: "frame" },
        // A stepped cornice proud of the carcass on three sides.
        { id: "corniceLow", type: "mesh.box", when: "=isCase && cornice", size: ["=width + 0.02", 0.022, "=depth + 0.01"], radius: 0.004, at: [0, "=top + 0.011", 0.005], region: "frame" },
        { id: "corniceTop", type: "mesh.box", when: "=isCase && cornice", size: ["=width + 0.05", 0.028, "=depth + 0.025"], radius: 0.006, at: [0, "=top + 0.036", 0.0125], region: "frame" },
        // --- Open frame: posts, lipped shelves, cross braces and levelling feet ------------------
        { id: "posts", type: "mesh.box", when: "=!isCase", repeat: "=(bays + 1) * 2", size: ["=post", "=height", "=post"], radius: 0.002, at: ["=-width / 2 + post / 2 + floor(index / 2) * (bayW + side)", "=height / 2", "=(index % 2 * 2 - 1) * (depth / 2 - post / 2)"], region: "frame" },
        { id: "feet", type: "mesh.cylinder", when: "=!isCase", repeat: "=(bays + 1) * 2", radius: "=post * 0.42", height: 0.012, segments: 16, bevel: 0.003, at: ["=-width / 2 + post / 2 + floor(index / 2) * (bayW + side)", 0, "=(index % 2 * 2 - 1) * (depth / 2 - post / 2)"], region: "frame" },
        { id: "sideRails", type: "mesh.box", when: "=!isCase", repeat: "=(bays + 1) * 2", size: ["=post * 0.6", "=post * 0.8", "=depth - post"], at: ["=-width / 2 + post / 2 + floor(index / 2) * (bayW + side)", "=index % 2 == 0 ? height - post * 0.4 : y0 - post * 0.4", 0], region: "frame" },
        { id: "braceX", type: "mesh.box", when: "=!isCase && braces", repeat: "=bays * 2", size: ["=hypot(bayW, height - y0) - 0.03", 0.006, 0.03], at: ["=-width / 2 + side + floor(index / 2) * (bayW + side) + bayW / 2", "=(height + y0) / 2", "=-depth / 2 + post / 2"], rotate: [90, 0, "=(index % 2 * 2 - 1) * deg(atan2(height - y0, bayW))"], region: "frame" },
        { id: "braceSide", type: "mesh.box", when: "=!isCase && braces", repeat: 4, size: [0.006, 0.03, "=hypot(depth - post, height - y0) - 0.03"], at: ["=(floor(index / 2) * 2 - 1) * (width / 2 + 0.003)", "=(height + y0) / 2", 0], rotate: ["=(index % 2 * 2 - 1) * deg(atan2(height - y0, depth - post))", 0, 0], region: "frame" },
        // --- Shelves: boards in a bookcase; lipped shelves on a frame ----------------------------
        {
            id: "boards", type: "mesh.box", repeat: "=bays * shelves", size: ["=bayW - 0.002", "=bd", "=sd"], radius: 0.0015, region: "shelf",
            at: ["=-width / 2 + side + floor(index / shelves) * (bayW + side) + bayW / 2", "=y0 + (index % shelves) * pitch + bd / 2", "=sz"],
        },
        { id: "lips", type: "mesh.box", when: "=!isCase", repeat: "=bays * shelves * 2", size: ["=bayW", "=bd * 1.6", 0.012], radius: 0.002, region: "frame", at: ["=-width / 2 + side + floor(index / (shelves * 2)) * (bayW + side) + bayW / 2", "=y0 + floor(index / 2) % shelves * pitch + bd * 0.2", "=(index % 2 * 2 - 1) * (depth / 2 - 0.006)"] },
        // The top shelf of an open rack.
        { id: "topShelf", type: "mesh.box", when: "=!isCase", repeat: "=bays", size: ["=bayW - 0.002", "=bd", "=sd"], radius: 0.0015, at: ["=-width / 2 + side + index * (bayW + side) + bayW / 2", "=height - bd / 2", 0], region: "shelf" },
        // --- Books: four bindings, each evaluated once and placed at every kept slot -------------
        { id: "bookA", type: "object", object: "household.book", output: false, params: { detail: "shelf", height: 0.24, width: 0.17, thickness: 0.03, binding: "hardcover", spineRound: 0.5, label: true, coverSlot: "cover" } },
        { id: "bookB", type: "object", object: "household.book", output: false, params: { detail: "shelf", height: 0.24, width: 0.17, thickness: 0.026, binding: "paperback", label: true, coverSlot: "cover2" } },
        { id: "bookC", type: "object", object: "household.book", output: false, params: { detail: "shelf", height: 0.24, width: 0.17, thickness: 0.032, binding: "leather", bands: 3, spineRound: 0.8, label: true, coverSlot: "cover3" } },
        { id: "bookD", type: "object", object: "household.book", output: false, params: { detail: "shelf", height: 0.24, width: 0.17, thickness: 0.028, binding: "hardcover", spineRound: 0.2, label: false, coverSlot: "cover4" } },
        {
            id: "bookRow", type: "geo.transform", when: "=bookCount > 0", repeat: "=bookCount",
            // Each row packs from its left end to its own share of the fill, with the odd book missing.
            keep: "=index % slots < slots * fill * randRange(floor(index / slots) * 3 + 101, 0.65, 1.2) && rand(index, 3) > 0.07",
            mesh: { switch: "=floor(rand(index, 5) * 4)", cases: { "0": "@bookA", "1": "@bookB", "2": "@bookC" }, default: "@bookD" },
            scale: ["=randRange(index * 7 + 1, 0.75, 1.05)", "=bh / 0.24 * randRange(index * 7 + 2, 0.72, 1)", "=bScaleZ * randRange(index * 7 + 3, 0.85, 1)"],
            at: [
                "=-width / 2 + side + floor(index / (shelves * slots)) * (bayW + side) + 0.01 + (index % slots + 0.5) * bp",
                "=y0 + floor(index / slots) % shelves * pitch + bd",
                "=sz + sd / 2 - 0.17 * bScaleZ / 2 - 0.012",
            ],
        },
    ],
    limits: { maxSize: 3.8, minSize: 0.3, maxTriangles: 400000 },
};

export default shelving;
