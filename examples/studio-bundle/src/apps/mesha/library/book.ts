import type { ObjectDef } from "../mesha_object";

/**
 * A book: a page block between hard boards round a rounded spine, or a paperback's soft wrap.
 * Closed, it stands on its tail with the spine facing +Z (as on a shelf) or lies on its back cover;
 * open, it lies spine along Z with each half rising from the gutter in a curve of pages.
 * `coverSlot` lets a shelf give each copy its own cover region (cover, cover2..cover4).
 */
const book: ObjectDef = {
    id: "household.book",
    name: "Book",
    category: "Household",
    tags: ["book", "hardcover", "paperback", "notebook", "journal", "atlas", "novel", "open book", "library", "reading"],
    description: "Hardcover, paperback or leather-bound book; standing, lying or open.",
    featured: ["height", "width", "thickness", "binding", "pose", "openAngle", "coverFinish"],
    groups: [
        { id: "size", label: "Size" },
        { id: "binding", label: "Binding" },
        { id: "pose", label: "Pose" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 0.235, min: 0.1, max: 0.45, unit: "m", decimals: 3, group: "size" },
        { id: "width", label: "Width", type: "number", default: 0.155, min: 0.07, max: 0.35, unit: "m", decimals: 3, group: "size" },
        { id: "thickness", label: "Thickness", type: "number", default: 0.032, min: 0.006, max: "=min(0.12, width * 0.6)", unit: "m", decimals: 3, group: "size", description: "Spine thickness: a few pages to a heavy tome." },
        { id: "binding", label: "Binding", type: "enum", default: "hardcover", options: ["hardcover", "paperback", "leather"], optionLabels: ["Hardcover", "Paperback", "Leather-bound"], group: "binding" },
        { id: "spineRound", label: "Spine rounding", type: "number", default: 0.6, min: 0, max: 1, group: "binding", visibleIf: "=binding != 'paperback'" },
        { id: "bands", label: "Raised bands", type: "int", default: 4, min: 0, max: 6, group: "binding", visibleIf: "=binding == 'leather'" },
        { id: "label", label: "Spine label", type: "bool", default: true, group: "binding" },
        { id: "pose", label: "Pose", type: "enum", default: "standing", options: ["standing", "lying", "open"], optionLabels: ["Standing", "Lying", "Open"], group: "pose" },
        { id: "openAngle", label: "Open angle", type: "number", default: 165, min: 70, max: 180, unit: "°", group: "pose", visibleIf: "=pose == 'open'" },
        { id: "coverFinish", label: "Cover", type: "material", default: "cloth.red", materials: ["cloth", "leather", "paint", "paper.kraft", "paper.white", "fabric"], group: "materials" },
        { id: "pageFinish", label: "Pages", type: "material", default: "paper.page", materials: ["paper.page", "paper.white", "paper.label"], group: "materials" },
        { id: "labelFinish", label: "Label and bands", type: "material", default: "metal.gold", materials: ["metal.gold", "metal.brass", "paper.label", "paint.black", "leather.black", "paint.white"], group: "materials" },
        { id: "detail", label: "Detail", type: "enum", default: "full", options: ["full", "shelf"], optionLabels: ["Full", "Shelf (light)"], group: "binding", variation: 0, description: "A light build for rows of books seen from across a room." },
        { id: "coverSlot", label: "Cover region", type: "enum", default: "cover", options: ["cover", "cover2", "cover3", "cover4"], group: "materials", visibleIf: "=false", variation: 0 },
        { id: "seed", label: "Seed", type: "seed", default: 2, group: "materials", variation: 0 },
    ],
    derived: {
        soft: "=binding == 'paperback'",
        bt: "=soft ? 0.0007 : clamp(thickness * 0.07, 0.0016, 0.0032)",
        // Hard boards stand proud of the page block by a few millimetres (the squares).
        sq: "=soft ? 0.0004 : clamp(height * 0.013, 0.002, 0.004)",
        r: "=thickness / 2",
        // How far the rounded spine bulges past the boards' front edges.
        bulge: "=soft ? 0 : r * spineRound",
        sz: "=width / 2 - bulge",
        blockT: "=thickness - 2 * bt - 0.0006",
        hb: "=blockT / 2",
        bandN: "=binding == 'leather' ? bands : 0",
        half: "=(180 - openAngle) / 2",
        lod: "=detail == 'shelf'",
        arcSeg: "=lod ? 5 : 16",
    },
    rules: [
        { check: "=thickness < height * 0.5", message: "Thicker than a book is tall." },
    ],
    regions: {
        cover: { label: "Cover", material: "=coverFinish" },
        cover2: { label: "Cover (2)", material: "=coverFinish" },
        cover3: { label: "Cover (3)", material: "=coverFinish" },
        cover4: { label: "Cover (4)", material: "=coverFinish" },
        pages: { label: "Pages", material: "=pageFinish" },
        label: { label: "Label", material: "=labelFinish" },
    },
    presets: [
        { name: "Cloth novel", values: { height: 0.21, width: 0.14, thickness: 0.028, binding: "hardcover", spineRound: 0.5, label: true, coverFinish: "cloth.green", labelFinish: "metal.gold" } },
        { name: "Paperback", values: { height: 0.178, width: 0.11, thickness: 0.022, binding: "paperback", label: true, coverFinish: "paint.terracotta", labelFinish: "paint.white" } },
        { name: "Leather tome", values: { height: 0.3, width: 0.22, thickness: 0.075, binding: "leather", bands: 5, spineRound: 0.9, coverFinish: "leather.brown", labelFinish: "metal.gold", pageFinish: "paper.label" } },
        { name: "Atlas, open", values: { height: 0.38, width: 0.27, thickness: 0.03, binding: "hardcover", pose: "open", openAngle: 172, coverFinish: "cloth.blue", label: false } },
        { name: "Journal", values: { height: 0.21, width: 0.145, thickness: 0.02, binding: "hardcover", spineRound: 0.2, label: false, coverFinish: "leather.black", pose: "lying" } },
    ],
    nodes: [
        // --- Closed: standing on its tail (y = 0), spine toward +Z, boards in the YZ plane --------
        { id: "boards", type: "mesh.box", output: false, repeat: 2, size: ["=bt", "=height", "=width - bulge - 0.0004"], radius: "=lod ? 0 : soft ? 0.0002 : bt * 0.4", at: ["=(index * 2 - 1) * (thickness / 2 - bt / 2)", "=height / 2", "=-bulge / 2 - 0.0002"], region: "=coverSlot" },
        { id: "block", type: "mesh.box", output: false, size: ["=blockT", "=height - 2 * sq", "=width - sq - bulge - (soft ? bt : r * 0.3)"], radius: "=lod ? 0 : 0.0008", at: [0, "=height / 2", "=-(sq + bulge + (soft ? bt : r * 0.3)) / 2 + (soft ? 0 : 0)"], region: "pages" },
        // Spine: a half shell round the block's back edge, flattened toward the boards by its rounding.
        { id: "spineArc", type: "curve.sector", output: false, inner: "=r - bt", outer: "=r", start: 0, end: 180, radius: "=lod ? 0 : bt * 0.3", segments: "=arcSeg" },
        { id: "spineFlat", type: "curve.transform", output: false, curve: "@spineArc", scale: [1, "=max(spineRound, 0.04)"] },
        { id: "spine", type: "mesh.extrude", output: false, when: "=!soft", outline: "@spineFlat", height: "=height", at: [0, 0, "=sz"], region: "=coverSlot" },
        { id: "softSpine", type: "mesh.box", output: false, when: "=soft", size: ["=thickness", "=height", "=bt"], radius: "=lod ? 0 : 0.0003", at: [0, "=height / 2", "=width / 2 - bt / 2"], region: "=coverSlot" },
        // Raised bands across a leather spine, and a label panel.
        { id: "bandArc", type: "curve.sector", output: false, inner: "=r * 0.6", outer: "=r + 0.0014", start: 16, end: 164, radius: "=lod ? 0 : 0.0005", segments: "=arcSeg" },
        { id: "bandFlat", type: "curve.transform", output: false, curve: "@bandArc", scale: [1, "=max(spineRound, 0.04) * (r + 0.0014 * 3) / (r + 0.0014)"] },
        { id: "spineBands", type: "mesh.extrude", output: false, repeat: "=bandN", outline: "@bandFlat", height: "=clamp(height * 0.016, 0.0025, 0.005)", at: [0, "=height * (0.14 + 0.72 * (index + 0.5) / count)", "=sz"], region: "label" },
        { id: "labelArc", type: "curve.sector", output: false, inner: "=r * 0.7", outer: "=r + 0.0004", start: 28, end: 152, radius: "=lod ? 0 : 0.0004", segments: "=lod ? 3 : 10" },
        { id: "labelFlat", type: "curve.transform", output: false, curve: "@labelArc", scale: [1, "=max(spineRound, 0.04)"] },
        { id: "spineLabel", type: "mesh.extrude", output: false, when: "=label && !soft", outline: "@labelFlat", height: "=height * (bandN > 1 ? 0.72 / bandN * 0.6 : 0.16)", at: [0, "=bandN > 1 ? height * (0.14 + 0.72 * 1 / bandN) + 0.004 : height * 0.66", "=sz"], region: "label" },
        { id: "softLabel", type: "mesh.box", output: false, when: "=label && soft", size: ["=thickness * 0.7", "=height * 0.22", 0.0006], at: [0, "=height * 0.66", "=width / 2"], region: "label" },
        { id: "closedBook", type: "geo.join", output: false, meshes: ["@boards", "@block", "@spine", "@softSpine", "@spineBands", "@spineLabel", "@softLabel"] },
        { id: "standing", type: "geo.transform", when: "=pose == 'standing'", mesh: "@closedBook" },
        { id: "lying", type: "geo.transform", when: "=pose == 'lying'", mesh: "@closedBook", rotate: [0, 0, 90], at: ["=height / 2", "=thickness / 2", 0], rest: true },
        // --- Open: lying on its back, gutter along Z through the origin, halves along +X and -X ---
        { id: "openBoard", type: "mesh.box", output: false, size: ["=width - bulge * 0.5", "=bt", "=height"], radius: "=soft ? 0.0002 : bt * 0.4", at: ["=(width - bulge * 0.5) / 2 + bulge * 0.5", "=bt / 2", 0], region: "=coverSlot" },
        // The page stack's section: thin at the gutter, swelling over the first fifth, flat to the fore-edge.
        {
            id: "pageSection", type: "curve.points", output: false, closed: true, smooth: 4,
            points: [
                ["=bulge * 0.5 + 0.002", "=bt + 0.0003"], ["=width - sq", "=bt + 0.0003"], ["=width - sq", "=bt + hb * 0.92"],
                ["=width * 0.62", "=bt + hb * 1.02"], ["=width * 0.28", "=bt + hb * 1.1 + width * 0.012"], ["=width * 0.1", "=bt + hb * 0.8 + width * 0.01"],
                ["=bulge * 0.5 + 0.004", "=bt + hb * 0.25"],
            ],
        },
        { id: "pageHalf", type: "mesh.extrude", output: false, outline: "@pageSection", height: "=height - 2 * sq", smoothAngle: 60, rotate: [-90, 0, 0], at: [0, 0, "=height / 2 - sq"], region: "pages" },
        // A loose leaf lifting off the stack: a thin curved section, extruded like the stack.
        {
            id: "leafSection", type: "curve.points", output: false, closed: true, smooth: 5,
            points: [
                ["=bulge * 0.5 + 0.006", "=bt + hb * 0.6"], ["=width * 0.2", "=bt + hb * 1.3 + width * 0.05"], ["=width * 0.55", "=bt + hb * 1.15 + width * 0.06"], ["=width - sq - 0.002", "=bt + hb * 1.1 + width * 0.035"],
                ["=width - sq - 0.002", "=bt + hb * 1.1 + width * 0.035 - 0.0006"], ["=width * 0.55", "=bt + hb * 1.15 + width * 0.06 - 0.0006"], ["=width * 0.2", "=bt + hb * 1.3 + width * 0.05 - 0.0006"], ["=bulge * 0.5 + 0.0066", "=bt + hb * 0.6 - 0.0006"],
            ],
        },
        { id: "leaf", type: "mesh.extrude", output: false, when: "=openAngle > 150", outline: "@leafSection", height: "=height - 2 * sq - 0.002", smoothAngle: 70, rotate: [-90, 0, 0], at: [0, 0, "=height / 2 - sq - 0.001"], region: "pages" },
        { id: "openHalf", type: "geo.join", output: false, meshes: ["@openBoard", "@pageHalf", "@leaf"] },
        { id: "openRight", type: "geo.transform", when: "=pose == 'open'", mesh: "@openHalf", rotate: [0, 0, "=half"], at: [0, "=sin(rad(half)) * 0.002", 0], rest: true },
        { id: "openLeftHalf", type: "geo.join", output: false, meshes: ["@openBoard", "@pageHalf"] },
        { id: "openLeft", type: "geo.transform", when: "=pose == 'open'", mesh: "@openLeftHalf", scale: [-1, 1, 1], rotate: [0, 0, "=-half"], at: [0, "=sin(rad(half)) * 0.002", 0], rest: true },
    ],
    limits: { maxSize: 0.8, minSize: 0.05, maxTriangles: 12000 },
};

export default book;
