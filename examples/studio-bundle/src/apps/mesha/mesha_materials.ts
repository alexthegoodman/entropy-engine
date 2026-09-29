// Material presets. A procedural object names its semantic regions (frame, upholstery, glass) and
// binds each to one of these by id, usually through a "finish" parameter, so a user picks "Walnut"
// or "Brushed steel" rather than tweaking shader numbers. Colors are sRGB.

export type Pattern = "none" | "wood" | "fabric" | "brushed" | "speckle" | "foliage" | "bark" | "birch"
    | "glow" | "corrugated" | "rust" | "rustyCorrugated" | "panels";

export interface MaterialPreset {
    id: string;
    label: string;
    color: [number, number, number];
    roughness: number;
    metallic: number;
    /**
     * A procedural surface detail the viewport shader draws on top of the base color. "glow" is
     * self-lit (light strips, crystals, lit windows); "corrugated" ribs sheet metal across each
     * face (down the slope on a roof); "rust" mottles and streaks it; "panels" draws the seams of
     * a panelled hull on a 1.2 x 0.8 m grid.
     */
    pattern: Pattern;
    /** Glass and similar: rendered as a tinted, glossy, slightly see-through-looking surface. */
    transmission?: number;
    /**
     * Foliage: a second color each leaf (or grass tip) leans toward by the fraction its uv.y
     * carries (see mesha_plants.ts), so an autumn crown mixes orange and red.
     */
    tint?: [number, number, number];
}

const hex = (h: string): [number, number, number] => {
    const v = parseInt(h.replace("#", ""), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

const m = (id: string, label: string, color: string, roughness: number, metallic: number, pattern: Pattern = "none", transmission?: number): MaterialPreset =>
    ({ id, label, color: hex(color), roughness, metallic, pattern, ...(transmission ? { transmission } : {}) });

/** Foliage: leaves, needles, grass and petals, with a second color they vary toward. */
const f = (id: string, label: string, color: string, tint: string, roughness = 0.55): MaterialPreset =>
    ({ id, label, color: hex(color), roughness, metallic: 0, pattern: "foliage", tint: hex(tint) });

export const MATERIALS: MaterialPreset[] = [
    m("wood.oak", "Oak", "#c49a6c", 0.55, 0, "wood"),
    m("wood.walnut", "Walnut", "#6b4631", 0.45, 0, "wood"),
    m("wood.ash", "Ash", "#dcc7a4", 0.6, 0, "wood"),
    m("wood.cherry", "Cherry", "#9a5236", 0.42, 0, "wood"),
    m("wood.ebony", "Ebonized", "#2e2622", 0.38, 0, "wood"),
    m("paint.white", "White lacquer", "#eeebe4", 0.3, 0),
    m("paint.sage", "Sage paint", "#9fae95", 0.45, 0),
    m("paint.terracotta", "Terracotta paint", "#c3714f", 0.5, 0),
    m("paint.navy", "Navy paint", "#2f3f5c", 0.4, 0),
    m("paint.black", "Black paint", "#232427", 0.35, 0),
    m("metal.chrome", "Chrome", "#e4e7eb", 0.08, 1),
    m("metal.steel", "Brushed steel", "#b9bdc2", 0.32, 1, "brushed"),
    m("metal.black", "Black steel", "#303236", 0.4, 1),
    m("metal.brass", "Brass", "#d2a85a", 0.25, 1, "brushed"),
    m("metal.copper", "Copper", "#c77b52", 0.28, 1),
    m("metal.aluminum", "Aluminum", "#cfd2d6", 0.35, 1, "brushed"),
    m("metal.zinc", "Zinc plated", "#aeb4b8", 0.3, 1, "speckle"),
    m("plastic.white", "White plastic", "#f1f1ee", 0.35, 0),
    m("plastic.black", "Black plastic", "#1f2023", 0.45, 0),
    m("plastic.grey", "Grey plastic", "#8b8f95", 0.45, 0),
    m("plastic.red", "Red plastic", "#c8412f", 0.35, 0),
    m("rubber.black", "Rubber", "#1b1b1d", 0.85, 0),
    m("fabric.charcoal", "Charcoal fabric", "#3b3d42", 0.95, 0, "fabric"),
    m("fabric.oatmeal", "Oatmeal fabric", "#cbbfa8", 0.95, 0, "fabric"),
    m("fabric.navy", "Navy fabric", "#2c3a57", 0.95, 0, "fabric"),
    m("fabric.olive", "Olive fabric", "#6d7048", 0.95, 0, "fabric"),
    m("fabric.rust", "Rust fabric", "#a2512f", 0.95, 0, "fabric"),
    m("leather.tan", "Tan leather", "#a8693e", 0.5, 0, "speckle"),
    m("leather.black", "Black leather", "#252325", 0.45, 0, "speckle"),
    m("glass.clear", "Clear glass", "#d9ecef", 0.04, 0, "none", 0.85),
    m("glass.green", "Green glass", "#4f8a5c", 0.05, 0, "none", 0.7),
    m("glass.amber", "Amber glass", "#9b5a1c", 0.05, 0, "none", 0.7),
    m("glass.frosted", "Frosted glass", "#e6eef0", 0.5, 0, "none", 0.6),
    m("ceramic.white", "White ceramic", "#f2efe8", 0.22, 0),
    m("ceramic.speckled", "Speckled stoneware", "#d8cdb8", 0.6, 0, "speckle"),
    m("stone.granite", "Granite", "#8d8a86", 0.7, 0, "speckle"),
    m("stone.sandstone", "Sandstone", "#c2a27a", 0.85, 0, "speckle"),
    m("stone.slate", "Slate", "#55595e", 0.75, 0, "speckle"),
    m("stone.marble", "Marble", "#ece9e4", 0.25, 0, "speckle"),
    m("masonry.brick", "Red brick", "#9a4a36", 0.85, 0, "speckle"),
    m("masonry.buff", "Buff brick", "#c9a57a", 0.85, 0, "speckle"),
    m("masonry.whitewash", "Whitewashed brick", "#e4ddd1", 0.8, 0, "speckle"),
    m("masonry.stucco", "Cream stucco", "#e3d6bc", 0.9, 0, "speckle"),
    m("masonry.fieldstone", "Fieldstone", "#8f8373", 0.9, 0, "speckle"),
    m("roofing.slate", "Slate tiles", "#3f4449", 0.7, 0, "speckle"),
    m("roofing.shingle", "Asphalt shingles", "#4a4644", 0.9, 0, "speckle"),
    m("roofing.clay", "Clay tiles", "#a9573a", 0.75, 0, "speckle"),
    m("roofing.cedar", "Cedar shakes", "#8a6446", 0.85, 0, "wood"),
    m("roofing.seam", "Standing seam", "#5d6469", 0.35, 0.8, "brushed"),
    m("paper.label", "Paper label", "#efe6cf", 0.8, 0),
    m("paper.kraft", "Kraft label", "#b88f5f", 0.85, 0),
    m("cork", "Cork", "#b9895a", 0.9, 0, "speckle"),
    m("ceramic.terracotta", "Terracotta", "#b5653f", 0.88, 0, "speckle"),
    m("soil", "Potting soil", "#43342a", 0.95, 0, "speckle"),
    m("bark.oak", "Oak bark", "#5e4b3b", 0.9, 0, "bark"),
    m("bark.grey", "Grey bark", "#7d786e", 0.85, 0, "bark"),
    m("bark.dark", "Dark bark", "#3b302a", 0.9, 0, "bark"),
    m("bark.pine", "Pine bark", "#7b4b33", 0.9, 0, "bark"),
    m("bark.birch", "Birch bark", "#e7e3d8", 0.7, 0, "birch"),
    m("bark.palm", "Palm trunk", "#8c7b61", 0.9, 0, "bark"),
    m("stem.green", "Green stem", "#5b7f34", 0.6, 0),
    m("stem.brown", "Brown stem", "#6a5438", 0.75, 0),
    f("leaf.green", "Summer green", "#4a7a2c", "#86a03a"),
    f("leaf.spring", "Spring green", "#78aa38", "#b9cc4c"),
    f("leaf.dark", "Evergreen", "#2c5226", "#4b6e2c", 0.45),
    f("leaf.olive", "Silver olive", "#7a8a5c", "#a9ad84", 0.6),
    f("leaf.tropical", "Tropical", "#2b6a33", "#5d9440", 0.4),
    f("leaf.autumn", "Autumn orange", "#d27a28", "#b3301c"),
    f("leaf.gold", "Autumn gold", "#dfb13a", "#c8742a"),
    f("leaf.red", "Maple red", "#b0261d", "#e0662a"),
    f("leaf.purple", "Copper beech", "#5a2934", "#8a4436"),
    f("leaf.blossom", "Cherry blossom", "#f1bfcd", "#fbe7ee", 0.6),
    f("leaf.spruce", "Spruce needles", "#2b4a2b", "#446336", 0.6),
    f("leaf.blue", "Blue spruce", "#5e7f86", "#8ea8a8", 0.6),
    f("leaf.fern", "Fern green", "#5a8c33", "#93b443"),
    f("leaf.palm", "Palm green", "#5a8a38", "#b0a64a"),
    f("leaf.succulent", "Succulent", "#8db3a2", "#d38c9c", 0.45),
    f("grass.lawn", "Lawn grass", "#4a8a2c", "#a2b84c", 0.6),
    f("grass.meadow", "Meadow grass", "#6d9a38", "#d4c27c", 0.65),
    f("grass.dry", "Dry grass", "#b3a064", "#e4d6a2", 0.75),
    f("grass.lavender", "Lavender", "#6f8a6b", "#7d5cc4", 0.7),
    f("flower.white", "White petals", "#f4f1e8", "#f6e7a8", 0.5),
    f("flower.cream", "Cream plumes", "#e8dcbc", "#f4ecd6", 0.8),
    f("flower.yellow", "Yellow petals", "#f3c02a", "#ef8a1c", 0.5),
    f("flower.orange", "Orange petals", "#ef7420", "#f2a832", 0.5),
    f("flower.red", "Red petals", "#c61f2b", "#861020", 0.5),
    f("flower.pink", "Pink petals", "#e777a4", "#f6bcd2", 0.5),
    f("flower.purple", "Purple petals", "#7747a8", "#a67cd6", 0.5),
    f("flower.blue", "Blue petals", "#4672c6", "#8fb0ea", 0.5),
    // Themed architecture: sci-fi hulls, wasteland salvage and magical glows.
    m("composite.white", "White composite", "#e9eaea", 0.35, 0, "panels"),
    m("composite.grey", "Grey composite", "#8e949a", 0.4, 0, "panels"),
    m("composite.orange", "Signal orange composite", "#d9682c", 0.4, 0, "panels"),
    m("metal.titanium", "Titanium", "#a8aaa6", 0.3, 1, "brushed"),
    m("metal.gold", "Gold foil", "#d8a93c", 0.2, 1, "speckle"),
    m("metal.corrugated", "Galvanized corrugated", "#a9aeb1", 0.38, 1, "corrugated"),
    m("metal.corrugatedRust", "Rusted corrugated", "#8d8b86", 0.55, 1, "rustyCorrugated"),
    m("metal.corrugatedRed", "Red corrugated", "#8e3a2c", 0.5, 0, "rustyCorrugated"),
    m("metal.corrugatedGreen", "Green corrugated", "#50624a", 0.5, 0, "rustyCorrugated"),
    m("metal.rust", "Rusted steel", "#6e6560", 0.6, 1, "rust"),
    m("metal.rustRed", "Rusted red plate", "#83392b", 0.6, 0, "rust"),
    m("metal.rustYellow", "Rusted hazard yellow", "#c49a2c", 0.55, 0, "rust"),
    m("masonry.concrete", "Concrete", "#a39f98", 0.9, 0, "speckle"),
    m("masonry.darkConcrete", "Weathered concrete", "#6f6c67", 0.92, 0, "rust"),
    m("wood.weathered", "Weathered boards", "#8b8171", 0.85, 0, "wood"),
    m("wood.charred", "Charred timber", "#3a3330", 0.9, 0, "wood"),
    m("fabric.canvas", "Canvas tarp", "#8c8467", 0.95, 0, "fabric"),
    m("fabric.sandbag", "Sandbag hessian", "#a8946b", 0.95, 0, "fabric"),
    m("solar.cell", "Solar cells", "#1d2a4a", 0.18, 0, "panels"),
    m("stone.regolith", "Regolith", "#8a7f74", 0.95, 0, "speckle"),
    m("stone.moss", "Mossy stone", "#6f7462", 0.92, 0, "speckle"),
    m("stone.purple", "Twilight stone", "#5f566c", 0.85, 0, "speckle"),
    m("masonry.plaster", "Lime plaster", "#e6dcc4", 0.9, 0, "speckle"),
    m("roofing.violet", "Twilight slate", "#473e5a", 0.7, 0, "speckle"),
    m("roofing.moss", "Mossy shingles", "#566041", 0.9, 0, "speckle"),
    m("paint.plum", "Plum paint", "#4c2c4f", 0.45, 0),
    m("paint.teal", "Teal paint", "#1f5f63", 0.45, 0),
    m("paint.ochre", "Ochre paint", "#b98a32", 0.5, 0),
    m("glass.tinted", "Smoked visor glass", "#3b4d5c", 0.03, 0, "none", 0.8),
    m("glass.violet", "Violet glass", "#6a4b9a", 0.05, 0, "none", 0.7),
    m("glass.fibreglass", "Fibreglass sheet", "#b9b28a", 0.55, 0, "corrugated", 0.45),
    m("glow.cyan", "Cyan light", "#62e3ff", 0.3, 0, "glow"),
    m("glow.white", "White light", "#f2f6ff", 0.3, 0, "glow"),
    m("glow.amber", "Amber light", "#ffb347", 0.3, 0, "glow"),
    m("glow.red", "Red light", "#ff4a3d", 0.3, 0, "glow"),
    m("glow.green", "Green light", "#7dff8a", 0.3, 0, "glow"),
    m("glow.violet", "Arcane violet", "#b27bff", 0.3, 0, "glow"),
    m("glow.magenta", "Magenta light", "#ff5fd2", 0.3, 0, "glow"),
    m("glow.candle", "Candlelit window", "#ffc76a", 0.3, 0, "glow"),
    m("fruit.green", "Green coconut", "#6f8a3a", 0.45, 0),
    m("fruit.coconut", "Ripe coconut", "#6b4a2b", 0.8, 0, "speckle"),
    m("fruit.red", "Red fruit", "#b3222a", 0.3, 0),
    m("fruit.orange", "Orange fruit", "#e5821f", 0.35, 0, "speckle"),
    m("flower.center", "Seed head", "#4a3219", 0.85, 0, "speckle"),
    m("flower.pollen", "Pollen yellow", "#e6ac1f", 0.8, 0, "speckle"),
];

export const MATERIAL_BY_ID: ReadonlyMap<string, MaterialPreset> = new Map(MATERIALS.map(p => [p.id, p]));

export const FALLBACK_MATERIAL: MaterialPreset = m("default", "Clay", "#c9c4bc", 0.6, 0);

export function material(id: string | undefined): MaterialPreset {
    return (id && MATERIAL_BY_ID.get(id)) || FALLBACK_MATERIAL;
}

/** Preset ids in a family: "wood" gives every wood.* id. */
export function materialFamily(prefix: string): string[] {
    return MATERIALS.filter(p => p.id === prefix || p.id.startsWith(prefix + ".")).map(p => p.id);
}
