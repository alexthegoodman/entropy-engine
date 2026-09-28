// Material presets. A procedural object names its semantic regions (frame, upholstery, glass) and
// binds each to one of these by id, usually through a "finish" parameter, so a user picks "Walnut"
// or "Brushed steel" rather than tweaking shader numbers. Colors are sRGB.

export type Pattern = "none" | "wood" | "fabric" | "brushed" | "speckle";

export interface MaterialPreset {
    id: string;
    label: string;
    color: [number, number, number];
    roughness: number;
    metallic: number;
    /** A procedural surface detail the viewport shader draws on top of the base color. */
    pattern: Pattern;
    /** Glass and similar: rendered as a tinted, glossy, slightly see-through-looking surface. */
    transmission?: number;
}

const hex = (h: string): [number, number, number] => {
    const v = parseInt(h.replace("#", ""), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

const m = (id: string, label: string, color: string, roughness: number, metallic: number, pattern: Pattern = "none", transmission?: number): MaterialPreset =>
    ({ id, label, color: hex(color), roughness, metallic, pattern, ...(transmission ? { transmission } : {}) });

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
    m("paper.label", "Paper label", "#efe6cf", 0.8, 0),
    m("paper.kraft", "Kraft label", "#b88f5f", 0.85, 0),
    m("cork", "Cork", "#b9895a", 0.9, 0, "speckle"),
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
