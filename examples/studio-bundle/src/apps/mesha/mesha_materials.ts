// Material presets. A procedural object names its semantic regions (frame, upholstery, glass) and
// binds each to one of these by id, usually through a "finish" parameter, so a user picks "Walnut"
// or "Brushed steel" rather than tweaking shader numbers. Colors are sRGB.

export type Pattern = "none" | "wood" | "fabric" | "brushed" | "speckle" | "foliage" | "bark" | "birch"
    | "glow" | "corrugated" | "rust" | "rustyCorrugated" | "panels" | "skin" | "hair" | "iris" | "denim" | "knit";

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
     * a panelled hull on a 1.2 x 0.8 m grid. "skin" scatters light under the surface (soft, warm
     * terminators) with pores, and reddens where uv.y carries a flush (lips, cheeks, knuckles);
     * "hair" is strands: a highlight along each strand (uv.y runs root to tip, uv.x is a per-strand
     * random), darker roots and thinning tips; "iris" draws radial fibres, a collarette and a dark
     * limbal ring from polar uv; "denim" is a diagonal twill, "knit" rows of stitches.
     */
    pattern: Pattern;
    /** Glass and similar: rendered as a tinted, glossy, slightly see-through-looking surface. */
    transmission?: number;
    /**
     * Window glass you can really see through: the share of the pane the viewport leaves out (in
     * a fine ordered dither, fewer at grazing angles where glass mirrors more), so an interior
     * shows behind it. Opaque pipelines need no sorting for it.
     */
    clear?: number;
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

/** Window glass: tinted, glossy, and `clear` of it really see-through (see MaterialPreset.clear). */
const g = (id: string, label: string, color: string, clear: number): MaterialPreset =>
    ({ id, label, color: hex(color), roughness: 0.03, metallic: 0, pattern: "none", transmission: 0.85, clear });

/** Foliage: leaves, needles, grass and petals, with a second color they vary toward. */
const f = (id: string, label: string, color: string, tint: string, roughness = 0.55): MaterialPreset =>
    ({ id, label, color: hex(color), roughness, metallic: 0, pattern: "foliage", tint: hex(tint) });

/** Skin: subsurface-lit, with a second, ruddier color the flush in uv.y leans toward. */
const sk = (id: string, label: string, color: string, flush: string): MaterialPreset =>
    ({ id, label, color: hex(color), roughness: 0.5, metallic: 0, pattern: "skin", tint: hex(flush) });

/** Hair: strands with a tint toward which each strand's random leans (sun-lightened ends, grey). */
const hr = (id: string, label: string, color: string, tint: string, roughness = 0.38): MaterialPreset =>
    ({ id, label, color: hex(color), roughness, metallic: 0, pattern: "hair", tint: hex(tint) });

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
    // Transit: see-through window glass, liveries, and what street cars are fitted out with.
    g("glass.window", "Clear window glass", "#cfe2e4", 0.72),
    g("glass.windowTinted", "Tinted window glass", "#3f4c55", 0.5),
    g("glass.windowBronze", "Bronze window glass", "#6e5640", 0.55),
    g("glass.windowGreen", "Sea-green window glass", "#7fae9e", 0.62),
    m("paint.cream", "Cream enamel", "#ebe0c3", 0.32, 0),
    m("paint.crimson", "Crimson enamel", "#9e2329", 0.3, 0),
    m("paint.brunswick", "Brunswick green", "#1e4634", 0.34, 0),
    m("paint.signal", "Signal yellow", "#e5b021", 0.38, 0),
    m("paint.silver", "Silver livery", "#c3c7cb", 0.28, 0.6),
    m("wood.teak", "Varnished teak", "#8b5a2d", 0.32, 0, "wood"),
    m("fabric.moquette", "Transit moquette", "#2e3a6a", 0.95, 0, "fabric"),
    m("fabric.moquetteRed", "Red moquette", "#7a2430", 0.95, 0, "fabric"),
    m("leather.green", "Green leatherette", "#2f5440", 0.42, 0, "speckle"),
    m("rubber.floor", "Ribbed rubber floor", "#45484c", 0.82, 0, "corrugated"),
    m("stone.cobble", "Granite setts", "#77726b", 0.85, 0, "speckle"),
    m("stone.ballast", "Track ballast", "#6e6b67", 0.95, 0, "speckle"),
    m("wood.sleeper", "Creosoted sleepers", "#40332a", 0.9, 0, "wood"),
    m("glow.warmWhite", "Warm white light", "#fff0d4", 0.3, 0, "glow"),
];

// People: skin tones, lips, hair colors, eyes, and clothing fabrics. Pushed here so they sit
// together in material pickers.
MATERIALS.push(
    sk("skin.porcelain", "Porcelain skin", "#f0d2c0", "#e8a59a"),
    sk("skin.fair", "Fair skin", "#e6b9a0", "#e0948a"),
    sk("skin.light", "Light skin", "#d9a588", "#cf7f72"),
    sk("skin.medium", "Medium skin", "#c38a66", "#b8675a"),
    sk("skin.olive", "Olive skin", "#ad7d57", "#a35e48"),
    sk("skin.tan", "Tan skin", "#9c6945", "#93503c"),
    sk("skin.brown", "Brown skin", "#7b4e33", "#7a3c2e"),
    sk("skin.deep", "Deep brown skin", "#5a3725", "#5e2c22"),
    sk("skin.ebony", "Ebony skin", "#3e261a", "#4a2219"),
    sk("lips.natural", "Natural lips", "#c27a6c", "#b2584f"),
    sk("lips.rose", "Rose lips", "#c45a6a", "#a83c50"),
    sk("lips.berry", "Berry lips", "#8e2f45", "#741c36"),
    sk("lips.red", "Red lips", "#b0232d", "#8f1420"),
    sk("lips.nude", "Nude lips", "#c69281", "#b0705f"),
    sk("lips.deep", "Deep lips", "#6e3a30", "#5a2a24"),
    m("nails.natural", "Natural nails", "#e7c3b8", 0.25, 0),
    m("nails.red", "Red polish", "#a3101e", 0.08, 0),
    m("nails.black", "Black polish", "#18161a", 0.06, 0),
    m("nails.nude", "Nude polish", "#d9a99a", 0.1, 0),
    hr("hair.black", "Black hair", "#17120f", "#2a201a", 0.32),
    hr("hair.darkBrown", "Dark brown hair", "#33221a", "#4c3222"),
    hr("hair.brown", "Brown hair", "#553624", "#7a5236"),
    hr("hair.chestnut", "Chestnut hair", "#6b3a22", "#8c5233"),
    hr("hair.auburn", "Auburn hair", "#7e321d", "#a2482a"),
    hr("hair.ginger", "Ginger hair", "#a9532a", "#c9773f"),
    hr("hair.darkBlonde", "Dark blonde hair", "#8c6c45", "#ae8c5e"),
    hr("hair.blonde", "Blonde hair", "#c09a64", "#e0c48e"),
    hr("hair.platinum", "Platinum hair", "#ddd0b4", "#f2ead6"),
    hr("hair.grey", "Grey hair", "#8a8681", "#c9c6c1"),
    hr("hair.white", "White hair", "#d8d5cf", "#f4f2ee"),
    hr("hair.saltPepper", "Salt and pepper hair", "#3a3633", "#bab6b0"),
    hr("hair.pink", "Pink dyed hair", "#d36f98", "#f0a7c3"),
    hr("hair.blue", "Blue dyed hair", "#2f5ea8", "#5f8fd6"),
    hr("hair.lashes", "Lashes", "#141110", "#221b17", 0.4),
    m("eye.sclera", "Eye white", "#efe8e2", 0.08, 0),
    m("eye.pupil", "Pupil", "#050505", 0.1, 0),
    { id: "eye.cornea", label: "Cornea", color: hex("#f4f7f8"), roughness: 0.02, metallic: 0, pattern: "none", transmission: 0.9, clear: 0.93 },
    m("iris.brown", "Brown eyes", "#5a3720", 0.2, 0, "iris"),
    m("iris.hazel", "Hazel eyes", "#7d6634", 0.2, 0, "iris"),
    m("iris.green", "Green eyes", "#5a7d48", 0.2, 0, "iris"),
    m("iris.blue", "Blue eyes", "#4a77a6", 0.2, 0, "iris"),
    m("iris.grey", "Grey eyes", "#7a8790", 0.2, 0, "iris"),
    m("iris.amber", "Amber eyes", "#a6702a", 0.2, 0, "iris"),
    m("iris.dark", "Dark brown eyes", "#2e1d14", 0.2, 0, "iris"),
    m("fabric.white", "White cotton", "#ecebe6", 0.92, 0, "fabric"),
    m("fabric.black", "Black cotton", "#1e1e21", 0.92, 0, "fabric"),
    m("fabric.heather", "Heather grey jersey", "#8f9095", 0.94, 0, "fabric"),
    m("fabric.red", "Red cotton", "#a3222a", 0.92, 0, "fabric"),
    m("fabric.forest", "Forest green cotton", "#2f4a36", 0.92, 0, "fabric"),
    m("fabric.sky", "Sky blue cotton", "#8fb3d6", 0.92, 0, "fabric"),
    m("fabric.mustard", "Mustard cotton", "#c99a2e", 0.92, 0, "fabric"),
    m("fabric.blush", "Blush silk", "#e2b3ab", 0.55, 0, "fabric"),
    m("fabric.khaki", "Khaki chino", "#b9a57d", 0.9, 0, "fabric"),
    m("fabric.denim", "Indigo denim", "#2f4366", 0.95, 0, "denim"),
    m("fabric.denimLight", "Washed denim", "#6c86ab", 0.95, 0, "denim"),
    m("fabric.denimBlack", "Black denim", "#26272b", 0.95, 0, "denim"),
    m("fabric.knitCream", "Cream knit", "#e3d8c2", 0.97, 0, "knit"),
    m("fabric.knitGrey", "Grey knit", "#77787c", 0.97, 0, "knit"),
    m("fabric.knitBurgundy", "Burgundy knit", "#6b2330", 0.97, 0, "knit"),
    m("leather.brown", "Brown leather", "#5a3522", 0.42, 0, "speckle"),
    m("leather.white", "White leather", "#eeece6", 0.4, 0, "speckle"),
    m("leather.red", "Red patent", "#9a1520", 0.12, 0),
    m("canvas.white", "White canvas", "#e9e6dc", 0.9, 0, "fabric"),
    m("rubber.white", "White rubber sole", "#ece9e1", 0.75, 0),
    m("rubber.gum", "Gum rubber sole", "#b98a52", 0.7, 0),
);

export const MATERIAL_BY_ID: ReadonlyMap<string, MaterialPreset> = new Map(MATERIALS.map(p => [p.id, p]));

export const FALLBACK_MATERIAL: MaterialPreset = m("default", "Clay", "#c9c4bc", 0.6, 0);

export function material(id: string | undefined): MaterialPreset {
    return (id && MATERIAL_BY_ID.get(id)) || FALLBACK_MATERIAL;
}

/** Preset ids in a family: "wood" gives every wood.* id. */
export function materialFamily(prefix: string): string[] {
    return MATERIALS.filter(p => p.id === prefix || p.id.startsWith(prefix + ".")).map(p => p.id);
}
