import type { ObjectDef } from "../mesha_object";

// A crooked magic shop: a stone ground floor with a bay shop window, a jettied, timber-framed
// upper floor under a steep, sagging gable roof, and a round stone tower on the left with a
// spiral stair and a curled witch-hat roof. Plan (front at +Z, tower at -X):
//
//        ___                          The tower opens into the shop and the front room above
//       /   \+----------------------+ through doorways in the left wall. Stairs are only in the
//      | T  )|  workroom  | back rm. | tower: stone block steps round a newel, climbing 300
//       \___/|------door--|--door----| degrees a storey from beside its doorway.
//            |   shop     | front rm.|
//            +--[ bay ]------[door]--+
//
// The tower wall is a ring of 60 narrow stone pieces per band; `keep` drops the pieces where its
// doorways and lancet windows are, so openings in a curved wall stay real openings. Walls use the
// house's conventions: rotate [-90, 0, 0] runs an outline's (u, v) along (+X, up) with its
// thickness toward -Z; rotate [-90, -90, 0] runs (u, v) along (+Z, up), thickness toward +X.

const PIECES = 60;
/** Tower piece helpers over a repeat of PIECES pieces per storey. */
const I = `(index % ${PIECES})`, S = `floor(index / ${PIECES})`;
const isDoor = `(${S} < 2 && min(${I}, ${PIECES} - ${I}) <= mD)`;
const winC = `round((floor(${I} / (${PIECES} / towerWindows)) + 0.5) * ${PIECES} / towerWindows)`;
const isWin = `(abs(${I} - ${winC}) <= mW && !(${S} < 2 && min(${winC}, ${PIECES} - ${winC}) * 6 < 64))`;
/** Window k of storey s (index = s * towerWindows + k): its centre piece, and whether it exists. */
const kC = `round(((index % towerWindows) + 0.5) * ${PIECES} / towerWindows)`;
const kS = `floor(index / towerWindows)`;
const kKeep = `=${kS} < tStoreys && !(${kS} < 2 && min(${kC}, ${PIECES} - ${kC}) * 6 < 64)`;
const kA = `(${kC} * 6)`;

/** A brace across a timber panel from (x0, y0) to (x1, y1) on a face at z. */
const brace = (x0: string, y0: string, x1: string, y1: string, z: string) => ({
    size: [`=hypot((${x1}) - (${x0}), (${y1}) - (${y0}))`, 0.13, 0.08],
    rotate: [0, 0, `=deg(atan2((${y1}) - (${y0}), (${x1}) - (${x0})))`],
    at: [`=((${x0}) + (${x1})) / 2`, `=((${y0}) + (${y1})) / 2`, `=${z}`],
});

/** Points of the sign bracket's scroll: a spiral in the (z, y) plane curling back toward the wall. */
const scroll = Array.from({ length: 19 }, (_, k) => {
    const a = (k / 18) * 1.6 * Math.PI, r = 0.2 * (1 - k / 24);
    return [0, `=y1 - 0.45 + ${(r * Math.sin(a)).toFixed(4)}`, `=D2 + 0.72 - ${(0.2 - r * Math.cos(a)).toFixed(4)}`] as [number, string, string];
});

export const arcaneEmporiumDef: ObjectDef = {
    id: "architecture.arcane_emporium",
    name: "Arcane Emporium",
    category: "Architecture",
    tags: ["magic", "magical", "wizard", "witch", "fantasy", "shop", "store", "retail", "apothecary", "alchemist", "tower", "half-timbered", "tudor", "crooked", "storybook", "medieval", "building", "interior", "spiral stair"],
    description: "A crooked magic shop: bay shop window and glazed door under a jettied, half-timbered upper floor, a stone tower with a spiral stair and a curled witch-hat roof, glowing crystals and a rune circle.",
    featured: ["width", "depth", "jetty", "pitch", "whimsy", "towerRadius", "hatHeight", "crystals", "litWindows", "stoneFinish"],
    groups: [
        { id: "size", label: "Shop" },
        { id: "front", label: "Shopfront" },
        { id: "windows", label: "Windows" },
        { id: "tower", label: "Tower" },
        { id: "magic", label: "Enchantments" },
        { id: "view", label: "Inspect" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        // --- Shop ---
        { id: "width", label: "Width", type: "number", default: 7.6, min: 6.4, max: 11, unit: "m", group: "size" },
        { id: "depth", label: "Depth", type: "number", default: 6.8, min: "=max(5.6, 2 * towerRadius + 2.4)", max: 9.5, unit: "m", group: "size", description: "The tower stands against the left wall; the shop keeps its doorway." },
        { id: "storeyHeight", label: "Storey height", type: "number", default: 3.0, min: 2.8, max: 3.5, unit: "m", group: "size" },
        { id: "jetty", label: "Jetty", type: "number", default: 0.5, min: 0, max: 0.8, unit: "m", group: "size", description: "How far the upper floor oversails the shopfront." },
        { id: "pitch", label: "Roof pitch", type: "number", default: 56, min: 42, max: 64, unit: "deg", group: "size" },
        { id: "whimsy", label: "Crookedness", type: "number", default: 0.6, min: 0, max: 1, group: "size", description: "Sags the roof, tilts the timbers, twists the chimney and curls the tower's hat." },
        { id: "shopShare", label: "Shop share", type: "number", default: 0.6, min: "=(towerRadius + 1.2) / depth", max: 0.72, group: "size", description: "How much of the depth is the shop; the workroom takes the rest." },
        // --- Shopfront ---
        { id: "bayWidth", label: "Bay window width", type: "number", default: 2.7, min: 1.6, max: "=width - 2.9", unit: "m", group: "front" },
        { id: "bayDepth", label: "Bay projection", type: "number", default: 0.55, min: 0.3, max: 0.8, unit: "m", group: "front" },
        { id: "doorOpen", label: "Door open", type: "number", default: 30, min: 0, max: 90, unit: "deg", group: "front" },
        { id: "sign", label: "Hanging sign", type: "bool", default: true, group: "front" },
        { id: "lantern", label: "Door lantern", type: "bool", default: true, group: "front" },
        // --- Windows ---
        { id: "windowWidth", label: "Upper window width", type: "number", default: 0.85, min: 0.6, max: "=min(1.2, width / 4 - 0.5)", unit: "m", group: "windows" },
        { id: "windowHeight", label: "Upper window height", type: "number", default: 1.15, min: 0.8, max: "=storeyHeight - 1.4", unit: "m", group: "windows" },
        { id: "panesX", label: "Panes across", type: "int", default: 2, min: 1, max: 4, group: "windows" },
        { id: "panesY", label: "Panes down", type: "int", default: 3, min: 1, max: 5, group: "windows" },
        { id: "moonWindows", label: "Moon windows", type: "bool", default: true, group: "windows", description: "Round windows in the gables." },
        // --- Tower ---
        { id: "towerRadius", label: "Tower radius", type: "number", default: 1.8, min: 1.5, max: 2.4, unit: "m", group: "tower" },
        { id: "towerTop", label: "Top room height", type: "number", default: 2.9, min: 2.6, max: 3.8, unit: "m", group: "tower" },
        { id: "towerWindows", label: "Windows per storey", type: "int", default: 4, min: 3, max: 6, group: "tower", description: "Around the tower; the ones facing the shop are left out below the top room." },
        { id: "hatHeight", label: "Hat height", type: "number", default: 5.6, min: 3, max: 8.5, unit: "m", group: "tower" },
        { id: "hatCurl", label: "Hat curl", type: "number", default: 0.65, min: 0, max: 1, group: "tower" },
        // --- Enchantments ---
        { id: "crystals", label: "Floating crystals", type: "int", default: 5, min: 0, max: 9, group: "magic" },
        { id: "runeCircle", label: "Rune circle", type: "bool", default: true, group: "magic" },
        { id: "litWindows", label: "Candlelit windows", type: "bool", default: false, group: "magic" },
        { id: "chimney", label: "Crooked chimney", type: "bool", default: true, group: "magic" },
        // --- Inspect ---
        { id: "roofVisible", label: "Show roofs", type: "bool", default: true, group: "view", variation: 0, description: "Lift the roof, top ceiling and the tower's hat off." },
        { id: "cutaway", label: "Hide upper floor", type: "bool", default: false, group: "view", variation: 0, description: "Cut the shop and tower down to the ground floor." },
        // --- Materials ---
        { id: "stoneFinish", label: "Stonework", type: "material", default: "stone.purple", materials: ["stone", "masonry.fieldstone", "masonry.brick", "masonry.buff"], group: "materials" },
        { id: "plasterFinish", label: "Plaster", type: "material", default: "masonry.plaster", materials: ["masonry.plaster", "masonry.stucco", "masonry.whitewash", "paint"], group: "materials" },
        { id: "timberFinish", label: "Timbers", type: "material", default: "wood.ebony", materials: ["wood"], group: "materials" },
        { id: "roofFinish", label: "Roof", type: "material", default: "roofing.violet", materials: ["roofing", "stone.slate"], group: "materials" },
        { id: "hatFinish", label: "Tower hat", type: "material", default: "roofing.violet", materials: ["roofing", "stone.slate", "metal.copper", "paint"], group: "materials" },
        { id: "trimFinish", label: "Shopfront and frames", type: "material", default: "paint.teal", materials: ["paint", "wood", "metal.brass", "metal.black"], group: "materials" },
        { id: "doorFinish", label: "Door", type: "material", default: "paint.plum", materials: ["paint", "wood"], group: "materials" },
        { id: "glassFinish", label: "Glass", type: "material", default: "glass.clear", materials: ["glass"], group: "materials", visibleIf: "=!litWindows" },
        { id: "glowFinish", label: "Magic glow", type: "material", default: "glow.violet", materials: ["glow"], group: "materials" },
        { id: "floorFinish", label: "Floors", type: "material", default: "wood.oak", materials: ["wood", "stone"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 7, group: "materials", variation: 0 },
    ],
    derived: {
        W2: "=width / 2", D2: "=depth / 2",
        pl: 0.3, H: "=storeyHeight", tw: 0.4, tu: 0.25,
        y1: "=pl + storeyHeight", yT: "=pl + 2 * storeyHeight",
        j: "=jetty", zF: "=depth / 2 + jetty",
        tp: "=tan(rad(pitch))", cp: "=cos(rad(pitch))",
        gH: "=width / 2 * tan(rad(pitch))", ridge: "=pl + 2 * storeyHeight + width / 2 * tan(rad(pitch))",
        ovR: 0.45, ovL: 0.12, ovF: 0.4, ovB: 0.3,
        showUp: "=!cutaway",
        roofShown: "=roofVisible && !cutaway",
        // Rooms.
        zP: "=depth / 2 - shopShare * depth",
        zShop: "=(depth / 2 - 0.4 + depth / 2 - shopShare * depth) / 2", zWork: "=(-depth / 2 + 0.4 + depth / 2 - shopShare * depth) / 2",
        zFront2: "=(depth / 2 + jetty - 0.25 + depth / 2 - shopShare * depth) / 2",
        // Shopfront.
        xD: "=width / 2 - 1.35", doorTop: 2.62,
        bw: "=bayWidth", bd: "=bayDepth", bsill: 0.62,
        bh: "=min(1.95, storeyHeight - 0.95)",
        xB: "=(-width / 2 + 0.45 + width / 2 - 1.35 - 0.75) / 2",
        nBv: "=max(2, round(bayWidth / 0.24))", nBh: "=max(2, round(min(1.95, storeyHeight - 0.95) / 0.3))",
        // Windows: ground floor fixed, upper floor from the parameters.
        gw: 0.9, gh: 1.3, gs: 0.85,
        ww: "=windowWidth", wh: "=windowHeight", ws: 0.8,
        xW: "=width / 4",
        leftBackWin: "=abs((-depth / 2 + 0.4 + depth / 2 - shopShare * depth) / 2 - (depth / 2 - towerRadius - 0.25)) > towerRadius + 0.8",
        moonR: "=min(0.5, width / 2 * tan(rad(pitch)) * 0.16)", moonY: "=width / 2 * tan(rad(pitch)) * 0.36",
        // Tower: centre, wall, pieces.
        rt: "=towerRadius", twt: 0.35, ri: "=towerRadius - 0.35",
        xT: "=-width / 2 - towerRadius + 0.35 - 0.12", zT: "=depth / 2 - towerRadius - 0.25",
        yTT: "=pl + 2 * storeyHeight + towerTop",
        tStoreys: "=cutaway ? 1 : 3",
        mD: "=floor(deg(0.56 / towerRadius) / 6 + 0.5)",
        mW: "=max(1, floor(deg(0.32 / towerRadius) / 6 + 0.5))",
        sillT: 0.9, whT: "=min(1.5, towerTop - 1.25, storeyHeight - 1.25)",
        chordT: "=2 * (towerRadius - 0.175) * sin(rad((2 * max(1, floor(deg(0.32 / towerRadius) / 6 + 0.5)) + 1) * 3))",
        // Spiral stair: nT block steps per storey over 300 degrees from th0.
        nR: "=ceil(storeyHeight / 0.19)", rh: "=storeyHeight / ceil(storeyHeight / 0.19)", nT: "=ceil(storeyHeight / 0.19) - 1",
        da: "=300 / (ceil(storeyHeight / 0.19) - 1)", th0: 32, thEnd: "=32 + 300",
        flights: "=cutaway ? 1 : 2",
        // Hat.
        hh: "=hatHeight", curl: "=hatCurl * (0.4 + 0.6 * whimsy)",
        hatTipX: "=-hatCurl * (0.4 + 0.6 * whimsy) * hatHeight * 0.42", hatTipY: "=hatHeight * (1 - 0.22 * hatCurl * (0.4 + 0.6 * whimsy))",
        // Roof slabs (undersides through the wall tops' outer edges).
        slR: "=(width / 2 + 0.45) / cos(rad(pitch))", slL: "=(width / 2 + 0.12) / cos(rad(pitch))",
        roofLen: "=depth + jetty + 0.4 + 0.3", roofZ: "=(depth / 2 + jetty + 0.4 - depth / 2 - 0.3) / 2",
        // Chimney.
        chX: "=width / 2 * 0.42", chZ: "=-depth / 2 + 1.0",
        chH: "=width / 2 * 0.42 * tan(rad(pitch)) + 1.6",
        // Timber framing: posts on the front face at these x.
        fp0: "=-width / 2 + 0.08", fp1: "=-width / 4 - windowWidth / 2 - 0.14", fp2: "=-width / 4 + windowWidth / 2 + 0.14",
        fp3: "=width / 4 - windowWidth / 2 - 0.14", fp4: "=width / 4 + windowWidth / 2 + 0.14", fp5: "=width / 2 - 0.08",
        nSideTimbers: "=max(3, round((depth + jetty) / 0.9) + 1)",
        // Rune circle.
        zRune: "=depth / 2 + 2.3",
    },
    rules: [
        { check: "=zT - 0.6 > zP", message: "The tower's doorway falls behind the shop's back wall: give the shop more depth." },
        { check: "=bw + 0.3 <= (xD - 0.75) - (-W2 + 0.45)", message: "The bay window runs into the door." },
    ],
    regions: {
        stone: { label: "Stonework", material: "=stoneFinish" },
        plaster: { label: "Plaster", material: "=plasterFinish" },
        timber: { label: "Timbers", material: "=timberFinish" },
        roof: { label: "Roof", material: "=roofFinish" },
        hat: { label: "Tower hat", material: "=hatFinish" },
        trim: { label: "Shopfront", material: "=trimFinish" },
        frame: { label: "Window frames", material: "=trimFinish" },
        casing: { label: "Door frame", material: "=trimFinish" },
        entry: { label: "Door", material: "=doorFinish" },
        sill: { label: "Sills and steps", material: "=stoneFinish" },
        hardware: { label: "Door hardware", material: "metal.brass" },
        glass: { label: "Glass", material: "=litWindows ? 'glow.candle' : glassFinish" },
        glow: { label: "Magic glow", material: "=glowFinish" },
        iron: { label: "Ironwork", material: "metal.black" },
        floors: { label: "Floors", material: "=floorFinish" },
        ceiling: { label: "Ceilings", material: "=plasterFinish" },
        pots: { label: "Chimney pots", material: "roofing.clay" },
        signboard: { label: "Sign board", material: "=doorFinish" },
    },
    presets: [
        { name: "Twilight emporium", values: {} },
        { name: "Hedge-witch apothecary", values: { width: 6.8, depth: 6.2, jetty: 0.35, pitch: 60, whimsy: 0.9, towerRadius: 1.6, hatHeight: 6.5, hatCurl: 1, crystals: 3, stoneFinish: "masonry.fieldstone", plasterFinish: "masonry.whitewash", timberFinish: "wood.walnut", roofFinish: "roofing.moss", hatFinish: "roofing.moss", trimFinish: "paint.sage", doorFinish: "paint.terracotta", glowFinish: "glow.green", floorFinish: "wood.oak", panesX: 3, panesY: 3 } },
        { name: "Archmage's curios", values: { width: 9.5, depth: 8, storeyHeight: 3.3, jetty: 0.7, pitch: 52, whimsy: 0.35, towerRadius: 2.2, towerTop: 3.4, towerWindows: 6, hatHeight: 7.5, hatCurl: 0.45, bayWidth: 4, crystals: 9, litWindows: true, stoneFinish: "stone.marble", plasterFinish: "paint.navy", timberFinish: "wood.ebony", roofFinish: "roofing.slate", hatFinish: "paint.navy", trimFinish: "metal.brass", doorFinish: "paint.navy", glowFinish: "glow.cyan", floorFinish: "stone.marble" } },
        { name: "Pumpkin-hat sweet shop", values: { width: 7, depth: 6.2, jetty: 0.6, pitch: 48, whimsy: 1, towerRadius: 1.7, towerWindows: 3, hatHeight: 4.2, hatCurl: 0.9, crystals: 6, stoneFinish: "masonry.buff", plasterFinish: "paint.white", timberFinish: "wood.cherry", roofFinish: "roofing.clay", hatFinish: "paint.terracotta", trimFinish: "paint.plum", doorFinish: "paint.ochre", glowFinish: "glow.amber" } },
        { name: "Grim grimoire vault", values: { width: 8, depth: 7.4, storeyHeight: 3.2, jetty: 0.25, pitch: 62, whimsy: 0.2, towerRadius: 2, towerTop: 3.6, hatHeight: 8, hatCurl: 0.2, crystals: 4, runeCircle: true, litWindows: true, stoneFinish: "stone.slate", plasterFinish: "paint.black", timberFinish: "wood.charred", roofFinish: "stone.slate", hatFinish: "stone.slate", trimFinish: "paint.black", doorFinish: "paint.black", glowFinish: "glow.red", floorFinish: "stone.slate" } },
    ],
    nodes: [
        // ================= Base and floors =================
        { id: "plinth", type: "mesh.box", size: ["=width + 0.1", "=pl", "=depth + 0.1"], at: [0, "=pl / 2", 0], region: "stone" },
        { id: "groundBoards", type: "mesh.box", size: ["=width - 2 * tw", 0.03, "=depth - 2 * tw"], at: [0, "=pl + 0.005", 0], region: "floors" },
        { id: "upperSlab", type: "mesh.box", when: "=showUp", size: ["=width - 0.02", 0.14, "=depth + j - 0.02"], at: [0, "=y1 - 0.07", "=j / 2"], region: "floors" },
        // Exposed joists under the upper floor; their ends carry the jetty.
        { id: "joists", type: "mesh.box", when: "=showUp", repeat: "=floor((width - 2 * tw) / 0.55)", size: [0.12, 0.2, "=depth + j - 0.05"], at: ["=-W2 + tw + (index + 0.5) * (width - 2 * tw) / floor((width - 2 * tw) / 0.55)", "=y1 - 0.24", "=j / 2"], region: "timber" },
        { id: "topCeiling", type: "mesh.box", when: "=roofShown", size: ["=width - 2 * tu", 0.08, "=depth + j - 2 * tu"], at: [0, "=yT + 0.04", "=j / 2"], region: "ceiling" },

        // ================= Ground floor: stone =================
        { id: "gFrontOutline", type: "curve.points", output: false, closed: true, points: [["=-W2", 0], ["=xD - 0.58", 0], ["=xD - 0.58", "=doorTop"], ["=xD + 0.58", "=doorTop"], ["=xD + 0.58", 0], ["=W2", 0], ["=W2", "=H - 0.14"], ["=-W2", "=H - 0.14"]] },
        { id: "bayHole", type: "curve.rect", output: false, width: "=bw", height: "=bh" },
        { id: "bayHoleAt", type: "curve.transform", output: false, curve: "@bayHole", offset: ["=xB", "=bsill + bh / 2"] },
        { id: "gFront", type: "mesh.extrude", outline: "@gFrontOutline", holes: ["@bayHoleAt"], height: "=tw", rotate: [-90, 0, 0], at: [0, "=pl", "=D2"], region: "stone" },
        { id: "gRect", type: "curve.rect", output: false, width: "=width", height: "=H - 0.14" },
        { id: "gRectAt", type: "curve.transform", output: false, curve: "@gRect", offset: [0, "=(H - 0.14) / 2"] },
        { id: "gWinHole", type: "curve.arch", output: false, width: "=gw", height: "=gh", rise: 0.25, segments: 12 },
        { id: "gBackHole", type: "curve.transform", output: false, curve: "@gWinHole", offset: [0, "=gs"] },
        { id: "gBack", type: "mesh.extrude", outline: "@gRectAt", holes: ["@gBackHole"], height: "=tw", rotate: [-90, 0, 0], at: [0, "=pl", "=-D2 + tw"], region: "stone" },
        { id: "gLeftOutline", type: "curve.points", output: false, closed: true, points: [["=-D2 + tw", 0], ["=zT - 0.55", 0], ["=zT - 0.55", 2.25], ["=zT + 0.55", 2.25], ["=zT + 0.55", 0], ["=D2 - tw", 0], ["=D2 - tw", "=H - 0.14"], ["=-D2 + tw", "=H - 0.14"]] },
        { id: "gSideHoleWork", type: "curve.transform", output: false, curve: "@gWinHole", offset: ["=zWork", "=gs"] },
        { id: "gSideHoleShop", type: "curve.transform", output: false, curve: "@gWinHole", offset: ["=zShop", "=gs"] },
        { id: "gLeft", type: "mesh.extrude", outline: "@gLeftOutline", holes: { if: "=leftBackWin", then: ["@gSideHoleWork"], else: [] }, height: "=tw", rotate: [-90, -90, 0], at: ["=-W2", "=pl", 0], region: "stone" },
        { id: "gRightOutline", type: "curve.rect", output: false, width: "=depth - 2 * tw", height: "=H - 0.14" },
        { id: "gRightOutlineAt", type: "curve.transform", output: false, curve: "@gRightOutline", offset: [0, "=(H - 0.14) / 2"] },
        { id: "gRight", type: "mesh.extrude", outline: "@gRightOutlineAt", holes: ["@gSideHoleWork", "@gSideHoleShop"], height: "=tw", rotate: [-90, -90, 0], at: ["=W2 - tw", "=pl", 0], region: "stone" },
        // The ground partition: shop in front, workroom behind, doorway on the right.
        { id: "gPartition", type: "curve.points", output: false, closed: true, points: [["=-W2 + tw", 0], ["=W2 - tw - 1.55", 0], ["=W2 - tw - 1.55", 2.15], ["=W2 - tw - 0.6", 2.15], ["=W2 - tw - 0.6", 0], ["=W2 - tw", 0], ["=W2 - tw", "=H - 0.14"], ["=-W2 + tw", "=H - 0.14"]] },
        { id: "gPartitionWall", type: "mesh.extrude", outline: "@gPartition", height: 0.14, rotate: [-90, 0, 0], at: [0, "=pl", "=zP + 0.07"], region: "plaster" },
        // Ground windows (composed), in wall-local coordinates like the house's.
        {
            id: "gWindow", type: "object", object: "architecture.window", output: false,
            params: { width: "=gw", height: "=gh", style: "casement", panesX: 2, panesY: 4, arch: 0.25, depth: 0.14, sillDepth: 0.16, frameWidth: 0.06, sill: true },
            at: [0, 0, 0.06],
        },
        { id: "gWindows", type: "geo.transform", repeat: 4, keep: "=index != 3 || leftBackWin", mesh: "@gWindow", rotate: [0, "=[180, 90, 90, -90][index]", 0], at: ["=[0, W2 - tw / 2, W2 - tw / 2, -W2 + tw / 2][index]", "=pl + gs", "=[-D2 + tw / 2, zWork, zShop, zWork][index]"] },
        // Quoins at the ground floor corners.
        {
            id: "quoins", type: "mesh.box", repeat: "=4 * floor((H - 0.3) / 0.36)", radius: 0.015, segments: 1,
            size: ["=floor(index / 4) % 2 == 0 ? 0.5 : 0.3", 0.3, "=floor(index / 4) % 2 == 0 ? 0.3 : 0.5"],
            at: ["=(index % 2 == 0 ? -1 : 1) * (W2 + 0.03 - (floor(index / 4) % 2 == 0 ? 0.25 : 0.15))", "=pl + 0.18 + floor(index / 4) * 0.36", "=(index < 2 ? -1 : 1) * (D2 + 0.03 - (floor(index / 4) % 2 == 0 ? 0.15 : 0.25))"],
            region: "stone",
        },

        // ================= Shopfront =================
        { id: "stallRiser", type: "mesh.box", size: ["=bw + 0.16", "=bsill", "=bd"], radius: 0.02, segments: 1, at: ["=xB", "=pl + bsill / 2", "=D2 + bd / 2"], region: "trim" },
        { id: "riserPanels", type: "mesh.box", repeat: 3, size: ["=bw / 3 - 0.14", "=bsill - 0.22", 0.03], at: ["=xB + (index - 1) * bw / 3", "=pl + bsill / 2", "=D2 + bd + 0.01"], region: "trim" },
        { id: "bayFrontGlass", type: "mesh.box", size: ["=bw", "=bh", 0.02], at: ["=xB", "=pl + bsill + bh / 2", "=D2 + bd - 0.06"], region: "glass" },
        { id: "baySideGlass", type: "mesh.box", repeat: 2, size: [0.02, "=bh", "=bd - 0.08"], at: ["=xB + (index == 0 ? -1 : 1) * bw / 2", "=pl + bsill + bh / 2", "=D2 + bd / 2 - 0.02"], region: "glass" },
        { id: "bayPosts", type: "mesh.box", repeat: 2, size: [0.09, "=bh", 0.09], at: ["=xB + (index == 0 ? -1 : 1) * bw / 2", "=pl + bsill + bh / 2", "=D2 + bd - 0.06"], region: "trim" },
        { id: "bayLeadV", type: "mesh.box", repeat: "=nBv - 1", size: [0.016, "=bh", 0.03], at: ["=xB - bw / 2 + (index + 1) * bw / nBv", "=pl + bsill + bh / 2", "=D2 + bd - 0.05"], region: "iron" },
        { id: "bayLeadH", type: "mesh.box", repeat: "=nBh - 1", size: ["=bw", 0.016, 0.03], at: ["=xB", "=pl + bsill + (index + 1) * bh / nBh", "=D2 + bd - 0.05"], region: "iron" },
        { id: "bayTransom", type: "mesh.box", size: ["=bw", 0.06, 0.05], at: ["=xB", "=pl + bsill + bh * 0.72", "=D2 + bd - 0.05"], region: "trim" },
        { id: "bayCornice", type: "mesh.box", size: ["=bw + 0.36", 0.2, "=bd + 0.16"], radius: 0.03, segments: 2, at: ["=xB", "=pl + bsill + bh + 0.1", "=D2 + bd / 2 + 0.04"], region: "trim" },
        { id: "bayRoof", type: "mesh.box", size: ["=bw + 0.42", 0.07, "=bd + 0.34"], rotate: [22, 0, 0], at: ["=xB", "=pl + bsill + bh + 0.3", "=D2 + bd / 2 + 0.04"], region: "roof" },
        { id: "bayRunes", type: "mesh.box", size: ["=bw - 0.2", 0.05, 0.02], at: ["=xB", "=pl + bsill + bh + 0.1", "=D2 + bd + 0.13"], region: "glow" },
        {
            id: "shopDoor", type: "object", object: "architecture.door",
            params: { width: 0.98, height: 2.12, depth: "=tw", exterior: true, style: "glazed", panesX: 2, panesY: 3, glassShare: 0.6, fanlight: 0.38, fanBars: 5, openAngle: "=doorOpen", casingWidth: 0.1, frameWidth: 0.05, handle: "knob" },
            at: ["=xD", "=pl", "=D2 - tw / 2"],
        },
        { id: "doorSteps", type: "mesh.box", repeat: 2, size: ["=index == 0 ? 1.6 : 1.4", "=index == 0 ? pl - 0.15 : pl", "=index == 0 ? 0.72 : 0.36"], radius: 0.02, segments: 1, at: ["=xD", "=index == 0 ? (pl - 0.15) / 2 : pl / 2", "=D2 + (index == 0 ? 0.36 : 0.18)"], region: "sill" },
        // Hanging sign: an iron arm with a scroll, chains and a board with a glowing star.
        { id: "signArm", type: "mesh.box", when: "=sign", size: [0.04, 0.04, 0.95], at: ["=xD - 0.9", "=y1 - 0.45", "=D2 + 0.47"], region: "iron" },
        { id: "signScrollPath", type: "path.points", output: false, smooth: 2, points: scroll },
        { id: "signScroll", type: "mesh.sweep", when: "=sign", path: "@signScrollPath", radius: 0.015, sides: 6, at: ["=xD - 0.9", 0, 0], region: "iron" },
        { id: "signStrut", type: "mesh.box", when: "=sign", size: [0.03, 0.03, 0.62], rotate: [-38, 0, 0], at: ["=xD - 0.9", "=y1 - 0.64", "=D2 + 0.24"], region: "iron" },
        { id: "signChains", type: "mesh.box", when: "=sign", repeat: 2, size: [0.015, 0.18, 0.015], at: ["=xD - 0.9", "=y1 - 0.56", "=D2 + 0.34 + index * 0.44"], region: "iron" },
        { id: "signBoard", type: "mesh.box", when: "=sign", size: [0.05, 0.56, 0.68], radius: 0.02, segments: 1, rotate: ["=(whimsy - 0.5) * 6", 0, 0], at: ["=xD - 0.9", "=y1 - 0.93", "=D2 + 0.56"], region: "signboard" },
        { id: "signStarShape", type: "curve.star", output: false, outer: 0.2, inner: 0.085, points: 5 },
        { id: "signStars", type: "mesh.extrude", when: "=sign", repeat: 2, outline: "@signStarShape", height: 0.012, rotate: [0, 0, 90], scale: ["=index == 0 ? 1 : -1", 1, 1], at: ["=xD - 0.9 + (index == 0 ? 0.026 : -0.026)", "=y1 - 0.93", "=D2 + 0.56"], region: "glow" },
        // Lantern on a bracket beside the door.
        { id: "lanternArm", type: "mesh.box", when: "=lantern", size: [0.04, 0.04, 0.34], at: ["=xD + 0.85", "=pl + 2.45", "=D2 + 0.17"], region: "iron" },
        { id: "lanternCage", type: "mesh.box", when: "=lantern", repeat: 4, size: [0.025, 0.36, 0.025], at: ["=xD + 0.85 + (index % 2 == 0 ? -0.1 : 0.1)", "=pl + 2.2", "=D2 + 0.34 + (index < 2 ? -0.1 : 0.1)"], region: "iron" },
        { id: "lanternCap", type: "mesh.cone", when: "=lantern", bottomRadius: 0.17, topRadius: 0.03, height: 0.16, segments: 4, rotate: [0, 45, 0], at: ["=xD + 0.85", "=pl + 2.38", "=D2 + 0.34"], region: "iron" },
        { id: "lanternBase", type: "mesh.box", when: "=lantern", size: [0.24, 0.04, 0.24], at: ["=xD + 0.85", "=pl + 2.02", "=D2 + 0.34"], region: "iron" },
        { id: "lanternFlame", type: "mesh.sphere", when: "=lantern", radius: 0.08, segments: 10, rings: 6, scale: [1, 1.5, 1], at: ["=xD + 0.85", "=pl + 2.2", "=D2 + 0.34"], region: "glow" },

        // ================= Upper floor: plaster and timber =================
        { id: "uFrontRect", type: "curve.rect", output: false, width: "=width", height: "=H" },
        { id: "uFrontRectAt", type: "curve.transform", output: false, curve: "@uFrontRect", offset: [0, "=H / 2"] },
        { id: "uWinHole", type: "curve.rect", output: false, width: "=ww", height: "=wh" },
        { id: "uWinRow", type: "curves.linear", output: false, curve: "@uWinHoleAt", count: 2, offset: ["=width / 2", 0] },
        { id: "uWinHoleAt", type: "curve.transform", output: false, curve: "@uWinHole", offset: [0, "=ws + wh / 2"] },
        { id: "uFront", type: "mesh.extrude", when: "=showUp", outline: "@uFrontRectAt", holes: ["@uWinRow"], height: "=tu", rotate: [-90, 0, 0], at: [0, "=y1", "=zF"], region: "plaster" },
        { id: "uBack", type: "mesh.extrude", when: "=showUp", outline: "@uFrontRectAt", holes: ["@uWinHoleAt"], height: "=tu", rotate: [-90, 0, 0], at: [0, "=y1", "=-D2 + tu"], region: "plaster" },
        { id: "uLeftOutline", type: "curve.points", output: false, closed: true, points: [["=-D2 + tu", 0], ["=zT - 0.55", 0], ["=zT - 0.55", 2.2], ["=zT + 0.55", 2.2], ["=zT + 0.55", 0], ["=zF - tu", 0], ["=zF - tu", "=H"], ["=-D2 + tu", "=H"]] },
        { id: "uSideHoleBack", type: "curve.transform", output: false, curve: "@uWinHole", offset: ["=zWork", "=ws + wh / 2"] },
        { id: "uSideHoleFront", type: "curve.transform", output: false, curve: "@uWinHole", offset: ["=zFront2", "=ws + wh / 2"] },
        { id: "uLeft", type: "mesh.extrude", when: "=showUp", outline: "@uLeftOutline", holes: { if: "=leftBackWin", then: ["@uSideHoleBack"], else: [] }, height: "=tu", rotate: [-90, -90, 0], at: ["=-W2", "=y1", 0], region: "plaster" },
        { id: "uRightOutline", type: "curve.points", output: false, closed: true, points: [["=-D2 + tu", 0], ["=zF - tu", 0], ["=zF - tu", "=H"], ["=-D2 + tu", "=H"]] },
        { id: "uRight", type: "mesh.extrude", when: "=showUp", outline: "@uRightOutline", holes: ["@uSideHoleBack", "@uSideHoleFront"], height: "=tu", rotate: [-90, -90, 0], at: ["=W2 - tu", "=y1", 0], region: "plaster" },
        { id: "uPartition", type: "curve.points", output: false, closed: true, points: [["=-W2 + tu", 0], ["=-0.48", 0], ["=-0.48", 2.1], ["=0.48", 2.1], ["=0.48", 0], ["=W2 - tu", 0], ["=W2 - tu", "=H"], ["=-W2 + tu", "=H"]] },
        { id: "uPartitionWall", type: "mesh.extrude", when: "=showUp", outline: "@uPartition", height: 0.12, rotate: [-90, 0, 0], at: [0, "=y1", "=zP + 0.06"], region: "plaster" },
        {
            id: "uWindow", type: "object", object: "architecture.window", output: false,
            params: { width: "=ww", height: "=wh", style: "casement", panesX: "=panesX", panesY: "=panesY", arch: 0, depth: 0.12, sillDepth: 0.1, frameWidth: 0.055, sill: true },
            at: [0, 0, 0.04],
        },
        {
            // Front left and right, back, right side back and front, left side back (if clear of the tower).
            id: "uWindows", type: "geo.transform", when: "=showUp", repeat: 6, keep: "=index != 5 || leftBackWin", mesh: "@uWindow",
            rotate: [0, "=[0, 0, 180, 90, 90, -90][index]", 0],
            at: ["=[-xW, xW, 0, W2 - tu / 2, W2 - tu / 2, -W2 + tu / 2][index]", "=y1 + ws", "=[zF - tu / 2, zF - tu / 2, -D2 + tu / 2, zWork, zFront2, zWork][index]"],
        },
        // Front timbers: posts either side of each window and at the corners, rails, and braces.
        { id: "fPosts", type: "mesh.box", when: "=showUp", repeat: 6, size: [0.16, "=H", 0.08], rotate: [0, 0, "=(rand(index, 3) - 0.5) * 5 * whimsy"], at: ["=[fp0, fp1, fp2, fp3, fp4, fp5][index]", "=y1 + H / 2", "=zF + 0.04"], region: "timber" },
        { id: "fRails", type: "mesh.box", when: "=showUp", repeat: 3, size: ["=width", 0.15, 0.08], at: [0, "=y1 + [0.08, ws - 0.07, H - 0.08][index]", "=zF + 0.04"], region: "timber" },
        { id: "fBraceL", type: "mesh.box", when: "=showUp", ...brace("fp0 + 0.08", "y1 + 0.16", "fp1 - 0.08", "y1 + H - 0.16", "zF + 0.05"), region: "timber" },
        { id: "fBraceR", type: "mesh.box", when: "=showUp", ...brace("fp5 - 0.08", "y1 + 0.16", "fp4 + 0.08", "y1 + H - 0.16", "zF + 0.05"), region: "timber" },
        { id: "fCrossA", type: "mesh.box", when: "=showUp", ...brace("fp2 + 0.08", "y1 + 0.16", "fp3 - 0.08", "y1 + H - 0.16", "zF + 0.05"), region: "timber" },
        { id: "fCrossB", type: "mesh.box", when: "=showUp", ...brace("fp3 - 0.08", "y1 + 0.16", "fp2 + 0.08", "y1 + H - 0.16", "zF + 0.06"), region: "timber" },
        // Side and back timbers: posts at even spacing, skipping the windows, with rails.
        {
            // index % 2: left or right; floor(index / 2): post along the side.
            id: "sPosts", type: "mesh.box", when: "=showUp", repeat: "=2 * nSideTimbers",
            keep: "=abs(-D2 + 0.08 + floor(index / 2) * (depth + j - 0.16) / (nSideTimbers - 1) - zWork) > ww / 2 + 0.12 && abs(-D2 + 0.08 + floor(index / 2) * (depth + j - 0.16) / (nSideTimbers - 1) - zFront2) > ww / 2 + 0.12 && (index % 2 == 1 || abs(-D2 + 0.08 + floor(index / 2) * (depth + j - 0.16) / (nSideTimbers - 1) - zT) > 0.7)",
            size: [0.08, "=H", 0.16], rotate: ["=(rand(index, 5) - 0.5) * 5 * whimsy", 0, 0],
            at: ["=(index % 2 == 0 ? -1 : 1) * (W2 + 0.04)", "=y1 + H / 2", "=-D2 + 0.08 + floor(index / 2) * (depth + j - 0.16) / (nSideTimbers - 1)"], region: "timber",
        },
        { id: "sRails", type: "mesh.box", when: "=showUp", repeat: 6, size: [0.08, 0.15, "=depth + j"], at: ["=(index % 2 == 0 ? -1 : 1) * (W2 + 0.04)", "=y1 + [0.08, ws - 0.07, H - 0.08][floor(index / 2)]", "=j / 2"], region: "timber" },
        { id: "bPosts", type: "mesh.box", when: "=showUp", repeat: 4, size: [0.16, "=H", 0.08], at: ["=[-W2 + 0.08, -ww / 2 - 0.14, ww / 2 + 0.14, W2 - 0.08][index]", "=y1 + H / 2", "=-D2 - 0.04"], region: "timber" },
        { id: "bRails", type: "mesh.box", when: "=showUp", repeat: 3, size: ["=width", 0.15, 0.08], at: [0, "=y1 + [0.08, ws - 0.07, H - 0.08][index]", "=-D2 - 0.04"], region: "timber" },
        { id: "bBraceL", type: "mesh.box", when: "=showUp", ...brace("-W2 + 0.16", "y1 + 0.16", "-ww / 2 - 0.22", "y1 + H - 0.16", "-D2 - 0.05"), region: "timber" },
        { id: "bBraceR", type: "mesh.box", when: "=showUp", ...brace("W2 - 0.16", "y1 + 0.16", "ww / 2 + 0.22", "y1 + H - 0.16", "-D2 - 0.05"), region: "timber" },
        // Jetty: a bressumer beam along the oversail and curved-looking brackets under the front posts.
        { id: "bressumer", type: "mesh.box", when: "=showUp && j > 0.1", size: ["=width + 0.04", 0.26, 0.2], radius: 0.02, segments: 1, at: [0, "=y1 - 0.13", "=zF - 0.1"], region: "timber" },
        { id: "jettyBrackets", type: "mesh.box", when: "=showUp && j > 0.15", repeat: 6, size: [0.12, 0.12, "=hypot(j, 0.7) + 0.05"], rotate: ["=-deg(atan2(0.7, j))", 0, 0], at: ["=[fp0 + 0.05, fp1, fp2, fp3, fp4, fp5 - 0.05][index]", "=y1 - 0.26 - 0.35", "=D2 + j / 2"], region: "timber" },

        // ================= Gables and roof =================
        { id: "gableTri", type: "curve.points", output: false, closed: true, points: [["=-W2", 0], ["=W2", 0], [0, "=gH"]] },
        { id: "moonHole", type: "curve.circle", output: false, radius: "=moonR", segments: 28, center: [0, "=moonY"] },
        { id: "gables", type: "mesh.extrude", when: "=roofShown", repeat: 2, outline: "@gableTri", holes: { if: "=moonWindows", then: ["@moonHole"], else: [] }, height: "=tu", rotate: [-90, 0, 0], at: [0, "=yT", "=index == 0 ? zF : -D2 + tu"], region: "plaster" },
        { id: "moonGlass", type: "mesh.cylinder", when: "=roofShown && moonWindows", repeat: 2, radius: "=moonR", height: 0.03, segments: 28, rotate: [90, 0, 0], at: [0, "=yT + moonY", "=index == 0 ? zF - tu / 2 : -D2 + tu / 2"], region: "glass" },
        { id: "moonFrames", type: "mesh.torus", when: "=roofShown && moonWindows", repeat: 2, major: "=moonR + 0.03", minor: 0.06, segments: 32, sides: 8, rotate: [90, 0, 0], at: [0, "=yT + moonY", "=index == 0 ? zF + 0.02 : -D2 - 0.02"], region: "timber" },
        { id: "moonBars", type: "mesh.box", when: "=roofShown && moonWindows", repeat: 4, size: ["=index % 2 == 0 ? 2 * moonR : 0.03", "=index % 2 == 0 ? 0.03 : 2 * moonR", 0.03], at: [0, "=yT + moonY", "=index < 2 ? zF - tu / 2 : -D2 + tu / 2"], region: "timber" },
        // Gable timbers: king post, collar and struts on both gables.
        { id: "kingPosts", type: "mesh.box", when: "=roofShown", repeat: 2, size: [0.16, "=gH - (moonWindows ? moonY + moonR + 0.06 : 0) - 0.15", 0.08], at: [0, "=yT + (moonWindows ? moonY + moonR + 0.06 : 0) + (gH - (moonWindows ? moonY + moonR + 0.06 : 0) - 0.15) / 2", "=index == 0 ? zF + 0.04 : -D2 - 0.04"], region: "timber" },
        { id: "collars", type: "mesh.box", when: "=roofShown", repeat: 2, size: ["=width * 0.62", 0.15, 0.08], at: [0, "=yT + gH * 0.19", "=index == 0 ? zF + 0.04 : -D2 - 0.04"], region: "timber" },
        { id: "gablePlates", type: "mesh.box", when: "=roofShown", repeat: 2, size: ["=width", 0.16, 0.08], at: [0, "=yT + 0.08", "=index == 0 ? zF + 0.04 : -D2 - 0.04"], region: "timber" },
        // Roof: two slabs, subdivided so the crookedness can sag and ripple them.
        { id: "roofRight", type: "mesh.box", output: false, size: ["=slR", 0.2, "=roofLen"], divisions: [8, 1, 12], rotate: [0, 0, "=-pitch"], at: ["=(W2 + ovR) / 2 + 0.1 * sin(rad(pitch))", "=yT + (W2 - (W2 + ovR) / 2) * tp + 0.1 * cp", "=roofZ"] },
        { id: "roofLeft", type: "mesh.box", output: false, size: ["=slL", 0.2, "=roofLen"], divisions: [8, 1, 12], rotate: [0, 0, "=pitch"], at: ["=-(W2 + ovL) / 2 - 0.1 * sin(rad(pitch))", "=yT + (W2 - (W2 + ovL) / 2) * tp + 0.1 * cp", "=roofZ"] },
        { id: "roofJoined", type: "geo.join", output: false, meshes: ["@roofRight", "@roofLeft"] },
        { id: "roof", type: "deform.noise", when: "=roofShown", mesh: "@roofJoined", amount: "=0.004 + 0.14 * whimsy", frequency: 0.3, octaves: 2, seed: "=seed", region: "roof" },
        { id: "ridgeRoll", type: "mesh.cylinder", when: "=roofShown", radius: 0.13, height: "=roofLen + 0.1", segments: 12, rotate: [90, 0, 0], at: [0, "=ridge + 0.2 / cp - 0.05", "=roofZ - roofLen / 2 - 0.05"], region: "roof" },
        { id: "barges", type: "mesh.box", when: "=roofShown", repeat: 4, size: ["=index % 2 == 0 ? slL : slR", 0.22, 0.06], rotate: [0, 0, "=(index % 2 == 0 ? 1 : -1) * pitch"], at: ["=(index % 2 == 0 ? -(W2 + ovL) : W2 + ovR) / 2", "=yT + (W2 - (index % 2 == 0 ? W2 + ovL : W2 + ovR) / 2) * tp + 0.05", "=index < 2 ? roofZ + roofLen / 2 + 0.03 : roofZ - roofLen / 2 - 0.03"], region: "timber" },
        // Crooked chimney: built at the origin, twisted and leaned, then placed on the right slope.
        { id: "chimneyStack", type: "mesh.box", output: false, size: [0.72, "=chH", 0.56], divisions: [1, 12, 1], at: [0, "=chH / 2", 0] },
        { id: "chimneyTwist", type: "deform.twist", output: false, mesh: "@chimneyStack", rate: "=whimsy * 7" },
        { id: "chimneyCap", type: "mesh.box", output: false, size: [0.86, 0.14, 0.7], radius: 0.02, segments: 1, rotate: [0, "=whimsy * 7 * chH", 0], at: [0, "=chH + 0.07", 0] },
        { id: "chimneyUnit", type: "geo.join", output: false, meshes: ["@chimneyTwist", "@chimneyCap"] },
        { id: "chimneyPlaced", type: "geo.transform", when: "=roofShown && chimney", mesh: "@chimneyUnit", rotate: [0, 0, "=-whimsy * 5"], at: ["=chX", "=yT + (W2 - chX) * tp - 0.6", "=chZ"], region: "stone" },
        { id: "chimneyPots", type: "mesh.cone", when: "=roofShown && chimney", repeat: 2, bottomRadius: 0.11, topRadius: 0.085, height: "=0.42 + index * 0.12", segments: 12, rotate: [0, 0, "=-whimsy * 5 + (index - 0.5) * 8 * whimsy"], at: ["=chX + (index - 0.5) * 0.36 + sin(rad(whimsy * 5)) * (chH + 0.14)", "=yT + (W2 - chX) * tp - 0.6 + cos(rad(whimsy * 5)) * (chH + 0.14)", "=chZ"], region: "pots" },

        // ================= Tower =================
        { id: "towerBase", type: "mesh.lathe", profile: [["=rt - twt", 0], ["=rt + 0.06", 0], ["=rt + 0.06", "=pl"], ["=rt - twt", "=pl"], ["=rt - twt", 0]], segments: 60, at: ["=xT", 0, "=zT"], region: "stone" },
        { id: "towerFloor0", type: "mesh.cylinder", radius: "=ri + 0.02", height: 0.03, segments: 40, at: ["=xT", "=pl - 0.02", "=zT"], region: "floors" },
        { id: "piece", type: "curve.sector", output: false, inner: "=ri", outer: "=rt", start: -3.05, end: 3.05, radius: 0, segments: 2 },
        {
            // Band A: floor to sill, open only at the doorways.
            id: "bandA", type: "mesh.extrude", repeat: `=${PIECES} * tStoreys`, keep: `=!${isDoor}`, outline: "@piece", height: "=sillT",
            rotate: [0, `=-${I} * 6`, 0], at: ["=xT", `=pl + ${S} * H`, "=zT"], region: "stone",
        },
        {
            // Band B: sill to window head, open at doorways and windows.
            id: "bandB", type: "mesh.extrude", repeat: `=${PIECES} * tStoreys`, keep: `=!${isDoor} && !${isWin}`, outline: "@piece", height: "=whT",
            rotate: [0, `=-${I} * 6`, 0], at: ["=xT", `=pl + ${S} * H + sillT`, "=zT"], region: "stone",
        },
        {
            // Band C: a solid ring from the window heads to the next floor (or the hat).
            id: "bandC", type: "mesh.lathe", repeat: "=tStoreys", segments: 60,
            profile: [["=ri", "=sillT + whT"], ["=rt", "=sillT + whT"], ["=rt", "=index < 2 ? H : towerTop"], ["=ri", "=index < 2 ? H : towerTop"], ["=ri", "=sillT + whT"]],
            at: ["=xT", "=pl + index * H", "=zT"], region: "stone",
        },
        { id: "towerCornice", type: "mesh.lathe", when: "=!cutaway", profile: [["=rt - 0.05", 0], ["=rt + 0.14", 0.04], ["=rt + 0.14", 0.22], ["=rt - 0.05", 0.26], ["=rt - 0.05", 0]], segments: 60, at: ["=xT", "=yTT - 0.3", "=zT"], region: "stone" },
        { id: "stringCourses", type: "mesh.lathe", repeat: "=tStoreys - 1", profile: [["=rt - 0.05", 0], ["=rt + 0.09", 0], ["=rt + 0.09", 0.14], ["=rt - 0.05", 0.14], ["=rt - 0.05", 0]], segments: 60, at: ["=xT", "=pl + (index + 1) * H - 0.07", "=zT"], region: "stone" },
        // Lancet windows: glass, a stone arch over each and a sill.
        { id: "towerGlass", type: "mesh.box", repeat: "=3 * towerWindows", keep: kKeep, size: ["=chordT + 0.02", "=whT", 0.03], rotate: [0, `=90 - ${kA}`, 0], at: [`=xT + (rt - twt / 2) * cos(rad(${kA}))`, `=pl + ${kS} * H + sillT + whT / 2`, `=zT + (rt - twt / 2) * sin(rad(${kA}))`], region: "glass" },
        { id: "archPath", type: "path.arc", output: false, radius: "=chordT / 2 + 0.07", start: 0, end: 180, segments: 12 },
        { id: "archStone", type: "mesh.sweep", output: false, path: "@archPath", radius: 0.08, sides: 6 },
        { id: "towerArches", type: "geo.transform", repeat: "=3 * towerWindows", keep: kKeep, mesh: "@archStone", rotate: [-90, `=90 - ${kA}`, 0], at: [`=xT + (rt + 0.02) * cos(rad(${kA}))`, `=pl + ${kS} * H + sillT + whT`, `=zT + (rt + 0.02) * sin(rad(${kA}))`], region: "sill" },
        { id: "towerSills", type: "mesh.box", repeat: "=3 * towerWindows", keep: kKeep, size: ["=chordT + 0.2", 0.08, 0.2], rotate: [0, `=90 - ${kA}`, 0], at: [`=xT + (rt + 0.02) * cos(rad(${kA}))`, `=pl + ${kS} * H + sillT - 0.04`, `=zT + (rt + 0.02) * sin(rad(${kA}))`], region: "sill" },
        { id: "towerLead", type: "mesh.box", repeat: "=3 * towerWindows", keep: kKeep, size: [0.02, "=whT", 0.04], rotate: [0, `=90 - ${kA}`, 0], at: [`=xT + (rt - twt / 2 + 0.02) * cos(rad(${kA}))`, `=pl + ${kS} * H + sillT + whT / 2`, `=zT + (rt - twt / 2 + 0.02) * sin(rad(${kA}))`], region: "iron" },
        // Floors in the tower: sectors that leave the stairwell open where the flight below climbs through.
        { id: "towerFloorShape", type: "curve.sector", output: false, inner: 0.14, outer: "=ri + 0.02", start: "=thEnd + da * 0.5", end: "=th0 + 95 + 360", radius: 0, segments: 24 },
        { id: "towerFloors", type: "mesh.extrude", repeat: "=cutaway ? 0 : 2", outline: "@towerFloorShape", height: 0.16, at: ["=xT", "=pl + (index + 1) * H - 0.16", "=zT"], region: "floors" },
        // The spiral stair: stone block steps round a newel.
        { id: "stepShape", type: "curve.sector", output: false, inner: 0.12, outer: "=ri - 0.02", start: "=-da / 2 - 1", end: "=da / 2 + 1", radius: 0.01, segments: 4 },
        { id: "spiralSteps", type: "mesh.extrude", repeat: "=flights * nT", outline: "@stepShape", height: "=rh + 0.03", rotate: [0, "=-(th0 + (index % nT) * da)", 0], at: ["=xT", "=pl + floor(index / nT) * H + (index % nT) * rh - 0.03", "=zT"], region: "stone" },
        { id: "newel", type: "mesh.cylinder", radius: 0.14, height: "=cutaway ? H - 0.3 : 2 * H + 1.0", segments: 18, at: ["=xT", "=pl", "=zT"], region: "stone" },
        // The hat: a brim and a cone swept up a curling path.
        { id: "hatBrim", type: "mesh.lathe", when: "=roofShown", profile: [["=rt - 0.1", 0], ["=rt + 0.62", 0], ["=rt + 0.62", 0.06], ["=rt + 0.3", 0.34], ["=rt - 0.1", 0.34], ["=rt - 0.1", 0]], segments: 48, at: ["=xT", "=yTT", "=zT"], region: "hat" },
        { id: "hatPath", type: "path.bezier", output: false, p0: [0, 0, 0], p1: [0, "=hh * 0.45", 0], p2: ["=hatTipX * 0.1", "=hh * 0.92", 0], p3: ["=hatTipX", "=hatTipY", "=hatTipX * 0.25"], segments: 28 },
        { id: "hat", type: "mesh.sweep", when: "=roofShown", path: "@hatPath", radius: "=rt + 0.3", sides: 36, taper: 0.03, at: ["=xT", "=yTT + 0.3", "=zT"], region: "hat" },
        { id: "hatBand", type: "mesh.torus", when: "=roofShown", major: "=(rt + 0.3) * 0.985", minor: 0.07, segments: 40, sides: 8, at: ["=xT", "=yTT + 0.42", "=zT"], region: "glow" },
        { id: "finialStarShape", type: "curve.star", output: false, outer: 0.34, inner: 0.14, points: 5 },
        { id: "finial", type: "mesh.extrude", when: "=roofShown", outline: "@finialStarShape", height: 0.06, bevel: 0.015, rotate: [90, 0, 0], at: ["=xT + hatTipX", "=yTT + 0.3 + hatTipY + 0.42", "=zT + hatTipX * 0.25 + 0.03"], region: "glow" },
        { id: "finialRod", type: "mesh.cylinder", when: "=roofShown", radius: 0.02, height: 0.3, segments: 6, at: ["=xT + hatTipX", "=yTT + 0.3 + hatTipY - 0.05", "=zT + hatTipX * 0.25"], region: "iron" },

        // ================= Enchantments =================
        { id: "crystal", type: "mesh.sphere", output: false, radius: 0.27, segments: 4, rings: 2 },
        {
            id: "floatingCrystals", type: "geo.transform", repeat: "=crystals", mesh: "@crystal",
            scale: ["=0.6 + rand(index, 71) * 0.3", "=1.4 + rand(index, 72) * 0.8", "=0.6 + rand(index, 71) * 0.3"],
            rotate: ["=(rand(index, 73) - 0.5) * 40", "=rand(index, 74) * 90", "=(rand(index, 75) - 0.5) * 40"],
            at: ["=xT + (rt + 1.0 + rand(index, 76) * 0.6) * cos(rad(index * 360 / max(1, crystals) + 150))", "=(cutaway ? y1 : yTT) + 0.6 + rand(index, 77) * 1.6", "=zT + (rt + 1.0 + rand(index, 76) * 0.6) * sin(rad(index * 360 / max(1, crystals) + 150))"], region: "glow",
        },
        { id: "runeRing", type: "mesh.torus", when: "=runeCircle", major: 1.05, minor: 0.035, segments: 64, sides: 6, scale: [1, 0.35, 1], at: ["=xD", 0.012, "=zRune"], region: "glow" },
        { id: "runeStarOuter", type: "curve.star", output: false, outer: 0.92, inner: 0.46, points: 6 },
        { id: "runeStarInner", type: "curve.star", output: false, outer: 0.84, inner: 0.4, points: 6 },
        { id: "runeStar", type: "mesh.extrude", when: "=runeCircle", outline: "@runeStarOuter", holes: ["@runeStarInner"], height: 0.012, at: ["=xD", 0.002, "=zRune"], region: "glow" },
        { id: "runeStones", type: "mesh.box", when: "=runeCircle", repeat: 6, size: [0.22, "=0.25 + rand(index, 81) * 0.25", 0.16], radius: 0.03, segments: 2, rotate: [0, "=index * 60 + 30", "=(rand(index, 82) - 0.5) * 12 * whimsy"], at: ["=xD + 1.35 * cos(rad(index * 60 + 30))", "=(0.25 + rand(index, 81) * 0.25) / 2", "=zRune + 1.35 * sin(rad(index * 60 + 30))"], region: "stone" },
        { id: "runeGlyphs", type: "mesh.box", when: "=runeCircle", repeat: 6, size: [0.08, 0.1, 0.02], rotate: [0, "=90 - (index * 60 + 30)", 0], at: ["=xD + 1.27 * cos(rad(index * 60 + 30))", "=0.12 + rand(index, 81) * 0.06", "=zRune + 1.27 * sin(rad(index * 60 + 30))"], region: "glow" },
    ],
    limits: { maxSize: 32, minSize: 6, maxTriangles: 250000 },
};

export default arcaneEmporiumDef;
