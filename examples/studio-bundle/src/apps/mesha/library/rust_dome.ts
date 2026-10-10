import type { ObjectDef } from "../mesha_object";

// A rusting, many-storeyed dome: the kind of place a wasteland story walks toward. A concrete drum
// of `drumStoreys` storeys carries a riveted steel shell that climbs the rest of the height, so the
// whole thing stands `storeys` storeys tall. The shell is a lattice (meridian ribs and ring beams)
// clad in curved panels; Decay drops panels (thickest round the breach), breaks, boards or lights
// windows. Inside, a floor deck per storey rings an open atrium round a lift core whose bridges
// reach every deck; a lantern hangs over the core and a beacon mast stands over the oculus.
//
//                 |  beacon on a mast, on a tripod over the oculus
//              .-'^'-.
//           .'/  |  \'.     shell panels between meridian ribs and ring beams (some missing)
//          /_/___|___\_\    ----- spring: the drum's top
//          |#| |#| |#| |    drum storeys: sill band, window band (piers between real openings),
//          |=============   head band; ledges at every storey line; buttresses on the piers
//          |##[ GATE ]##|   front (+Z): blast doors between pylons under a lintel
//
// Angles `b` are plan angles with the front (+Z) at b = 90, matching curve.sector: a point at
// radius d sits at (d cos b, d sin b). A box turned [0, 90 - b, 0] faces out at b; a shape whose
// +X is radial turns [0, -b, 0]; a lathe swept `sw` degrees and turned -(b0 + sw) covers b0..b0+sw.

/** Plan point at angle `b` (degrees) and radius `d` (expressions). */
const pt = (b: string, d: string): [string, string] => [`=(${d}) * cos(rad(${b}))`, `=(${d}) * sin(rad(${b}))`];

/** A closed annular sector b0..b1 between two radii, as inline outline points. */
const sector = (b0: string, b1: string, rin: string, rout: string, n = 6): [string, string][] => {
    const out: [string, string][] = [];
    for (let j = 0; j <= n; j++) out.push(pt(`(${b0}) + ((${b1}) - (${b0})) * ${j / n}`, rout));
    for (let j = n; j >= 0; j--) out.push(pt(`(${b0}) + ((${b1}) - (${b0})) * ${j / n}`, rin));
    return out;
};

/** A closed circle of radius `d`, as inline points. */
const circle = (d: string, n = 48): [string, string][] => Array.from({ length: n }, (_, j) => pt(`${(360 * j) / n}`, d));

// --- Window bands: storey S and window K of a repeat over drumStoreys * windowsPerStorey.
const S = "floor(index / windowsPerStorey)";
const K = "(index % windowsPerStorey)";
/** The window band of storey S reaches below the gate's top: the gate cuts it. */
const BAND_GATED = `(base + ${S} * sh + sill < gTop)`;
/** Window k (relative angle k * step from the front) overlaps the gate opening. */
const inGate = (k: string) => `((${k}) * step - wa < gh || (${k}) * step + wa > 360 - gh)`;
const PIER_START0 = `(${BAND_GATED} && ${inGate(K)} && ${K} * step < 180 ? max(gh, ${K} * step - wa) : ${K} * step + wa)`;
const PIER_END0 = `(${BAND_GATED} && ${inGate(`${K} + 1`)} && (${K} + 1) * step > 180 ? min(360 - gh, (${K} + 1) * step + wa) : (${K} + 1) * step - wa)`;
const PIER_START = `(${BAND_GATED} ? max(${PIER_START0}, gh) : ${PIER_START0})`;
const PIER_END = `(${BAND_GATED} ? min(${PIER_END0}, 360 - gh) : ${PIER_END0})`;
/** The window opening K of storey S is glazed (not swallowed by the gate). */
const WINDOW_OPEN = `!(${BAND_GATED} && ${inGate(K)})`;
const WB = `(90 + ${K} * step)`;
const LIT = "rand(index, 21) < litWindows";
const BOARDED = `!(${LIT}) && rand(index, 22) < boarded`;
const BROKEN = `!(${LIT}) && !(${BOARDED.replace(/index/g, "index")}) && rand(index, 23) < brokenPanes`;

// --- Solid bands: band J (0 sill, 1 head) of storey S2 in a repeat over drumStoreys * 2.
const S2 = "floor(index / 2)";
const BY = `(base + ${S2} * sh + (index % 2 == 0 ? 0 : sill + windowHeight))`;
const BH = `(index % 2 == 0 ? sill : sh - sill - windowHeight)`;

// --- Shell panels: ring R and sector Q in a repeat over panelRings * panelSectors.
const R = "floor(index / panelSectors)";
const Q = "(index % panelSectors)";
const phi = (j: number) => `(crown * (${R} + lerp(seam, 1 - seam, ${j / 3})) / panelRings)`;
const PANEL_SWEEP = `max(180 / panelSectors, 360 / panelSectors - deg(0.12 / (radius * max(0.15, cos(${phi(1.5)})))))`;
const panelProfile: [string, string][] = [
    ...[0, 1, 2, 3].map(j => [`=radius * cos(${phi(j)})`, `=spring + rise * sin(${phi(j)})`] as [string, string]),
    ...[3, 2, 1, 0].map(j => [`=ri * cos(${phi(j)})`, `=spring + (rise - wall) * sin(${phi(j)})`] as [string, string]),
    [`=radius * cos(${phi(0)})`, `=spring + rise * sin(${phi(0)})`],
];
/** Missing panels cluster round the breach and toward the crown. */
const PANEL_KEPT = `rand(index, 3) >= missingPanels * (0.35 + 1.3 * max(0, cos(rad(${Q} * 360 / panelSectors - breach)))) * (0.6 + 0.8 * ${R} / panelRings)`;

// --- Decks: deck k = index + 1 of a repeat over storeys - 1.
const DY = "(base + (index + 1) * sh)";
const DECK_OUT = `(${DY} <= spring + 0.001 ? ri - 0.03 : ri * sqrt(max(0, 1 - pow((${DY} - spring) / (rise - wall), 2))) - 0.06)`;
/** Low decks stop short of the front, leaving a lobby as tall as the gate. */
const DECK_LOBBY = `(${DY} - 0.3 < gTop + 0.6)`;

export const rustDomeDef: ObjectDef = {
    id: "architecture.rust_dome",
    name: "Rust Dome",
    category: "Architecture",
    tags: ["dome", "rust", "rusted", "post-apocalyptic", "apocalyptic", "wasteland", "sanctuary", "vault", "bunker", "citadel", "reactor", "observatory", "ark", "tower", "ruin", "abandoned", "destination", "beacon", "atrium", "storeys"],
    description: "A many-storeyed rusting dome: a concrete drum with real window openings under a ribbed steel shell with missing panels, a lobby behind half-open blast doors, decks round an atrium and lift core, and a beacon mast over the oculus.",
    featured: ["storeys", "radius", "drumStoreys", "missingPanels", "brokenPanes", "doorOpen", "beacon", "shellFinish"],
    groups: [
        { id: "size", label: "Tower" },
        { id: "shell", label: "Dome shell" },
        { id: "facade", label: "Drum and windows" },
        { id: "entry", label: "Gate" },
        { id: "inside", label: "Decks and core" },
        { id: "top", label: "Beacon" },
        { id: "view", label: "Inspect" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        // --- Tower ---
        { id: "storeys", label: "Storeys tall", type: "int", default: 5, min: 3, max: 8, group: "size", description: "Total height, to the top of the shell, in storeys." },
        { id: "storeyHeight", label: "Storey height", type: "number", default: 3.6, min: 3, max: 4.5, unit: "m", group: "size" },
        { id: "drumStoreys", label: "Drum storeys", type: "int", default: 2, min: 1, max: "=storeys - 2", group: "size", description: "Storeys of upright concrete wall under the shell." },
        { id: "radius", label: "Radius", type: "number", default: 14, min: 9, max: 20, unit: "m", group: "size" },
        { id: "wall", label: "Wall thickness", type: "number", default: 0.35, min: 0.2, max: 0.6, unit: "m", group: "size" },
        // --- Shell ---
        { id: "panelRings", label: "Panel rings", type: "int", default: 7, min: 4, max: 10, group: "shell" },
        { id: "panelSectors", label: "Panels around", type: "int", default: 24, min: 12, max: 36, group: "shell" },
        { id: "missingPanels", label: "Missing panels", type: "number", default: 0.2, min: 0, max: 0.6, group: "shell", description: "Decay: panels gone from the lattice, most round the breach." },
        { id: "breach", label: "Breach facing", type: "number", default: 125, min: 0, max: 360, unit: "deg", group: "shell", visibleIf: "=missingPanels > 0", description: "Plan angle of the worst damage (90 faces the gate)." },
        { id: "ribs", label: "Ribs and ring beams", type: "bool", default: true, group: "shell" },
        { id: "oculus", label: "Oculus", type: "number", default: 0.1, min: 0, max: 0.28, group: "shell", description: "Opening at the crown, as a share of the radius." },
        // --- Drum ---
        { id: "windowsPerStorey", label: "Windows per storey", type: "int", default: 20, min: 6, max: "=max(6, floor(2 * PI * radius / (windowWidth + 1)))", group: "facade" },
        { id: "windowWidth", label: "Window width", type: "number", default: 1.3, min: 0.7, max: 2.2, unit: "m", group: "facade" },
        { id: "windowHeight", label: "Window height", type: "number", default: 1.6, min: 0.9, max: "=storeyHeight - 1.2", unit: "m", group: "facade" },
        { id: "brokenPanes", label: "Broken panes", type: "number", default: 0.45, min: 0, max: 1, group: "facade" },
        { id: "boarded", label: "Boarded up", type: "number", default: 0.15, min: 0, max: 1, group: "facade" },
        { id: "litWindows", label: "Lit windows", type: "number", default: 0.06, min: 0, max: 1, group: "facade", description: "Someone is still in there." },
        { id: "ledges", label: "Storey ledges", type: "bool", default: true, group: "facade" },
        { id: "buttresses", label: "Buttresses", type: "int", default: 8, min: 0, max: 16, group: "facade" },
        // --- Gate ---
        { id: "gateWidth", label: "Gate width", type: "number", default: 5, min: 3, max: "=min(radius * 0.55, 9)", unit: "m", group: "entry" },
        { id: "gateHeight", label: "Gate height", type: "number", default: 4.6, min: "=min(2.8, drumStoreys * storeyHeight - 0.9)", max: "=drumStoreys * storeyHeight - 0.9", unit: "m", group: "entry" },
        { id: "doorOpen", label: "Blast doors open", type: "number", default: 0.35, min: 0, max: 1, group: "entry" },
        { id: "floodlights", label: "Floodlights", type: "bool", default: true, group: "entry" },
        // --- Inside ---
        { id: "decks", label: "Floor decks", type: "bool", default: true, group: "inside" },
        { id: "atrium", label: "Atrium", type: "number", default: 0.38, min: 0.25, max: 0.55, group: "inside", visibleIf: "=decks", description: "Open well radius, as a share of the radius." },
        { id: "core", label: "Lift core", type: "bool", default: true, group: "inside", visibleIf: "=decks" },
        // --- Beacon ---
        { id: "beacon", label: "Beacon mast", type: "bool", default: true, group: "top" },
        { id: "mastHeight", label: "Mast height", type: "number", default: 6, min: 2, max: 10, unit: "m", group: "top", visibleIf: "=beacon" },
        { id: "lantern", label: "Hanging lantern", type: "bool", default: true, group: "top" },
        // --- Inspect ---
        { id: "roofVisible", label: "Show shell", type: "bool", default: true, group: "view", variation: 0, description: "Lift the shell, its lattice and the beacon off to look at the decks." },
        // --- Materials ---
        { id: "shellFinish", label: "Shell panels", type: "material", default: "metal.rust", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "metal.corrugatedRust", "metal.copper", "metal.black", "composite.grey"], group: "materials" },
        { id: "patchFinish", label: "Odd panels", type: "material", default: "metal.rustDark", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "metal.corrugatedRust", "metal.copper", "metal.black", "metal.rustDark", "composite.grey"], group: "materials" },
        { id: "frameFinish", label: "Ribs and steel", type: "material", default: "metal.black", materials: ["metal.black", "metal.rust", "metal.rustRed", "metal.steel", "paint.black"], group: "materials" },
        { id: "wallFinish", label: "Drum", type: "material", default: "masonry.darkConcrete", materials: ["masonry", "stone"], group: "materials" },
        { id: "trimFinish", label: "Ledges and gate", type: "material", default: "masonry.concrete", materials: ["masonry", "stone"], group: "materials" },
        { id: "doorFinish", label: "Blast doors", type: "material", default: "metal.rustYellow", materials: ["metal.rust", "metal.rustRed", "metal.rustYellow", "metal.black", "paint.teal"], group: "materials" },
        { id: "floorFinish", label: "Floors", type: "material", default: "masonry.concrete", materials: ["masonry", "stone"], group: "materials" },
        { id: "glassFinish", label: "Glass", type: "material", default: "glass.windowGreen", materials: ["glass"], group: "materials" },
        { id: "boardFinish", label: "Boards", type: "material", default: "wood.weathered", materials: ["wood"], group: "materials", visibleIf: "=boarded > 0" },
        { id: "litFinish", label: "Lit windows", type: "material", default: "glow.amber", materials: ["glow"], group: "materials" },
        { id: "beaconFinish", label: "Beacon light", type: "material", default: "glow.green", materials: ["glow"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 41, group: "materials", variation: 0 },
    ],
    derived: {
        sh: "=storeyHeight", H: "=storeys * storeyHeight", drumH: "=drumStoreys * storeyHeight",
        base: 0.3, spring: "=base + drumH", rise: "=H - drumH", ri: "=radius - wall", rm: "=radius - wall / 2",
        crown: "=atan2(sqrt(1 - oculus * oculus), oculus)",
        yCrown: "=spring + rise * sin(crown)", rCrown: "=rm * cos(crown)",
        seam: "=min(0.12, 0.08 * panelRings / max(1, rise))",
        step: "=360 / windowsPerStorey", sill: "=(storeyHeight - windowHeight) * 0.45", wa: "=deg(windowWidth / 2 / radius)",
        gh: "=deg(atan2(gateWidth / 2, sqrt(ri * ri - gateWidth * gateWidth / 4)))",
        gTop: "=base + gateHeight",
        gS: "=floor((gTop - base) / storeyHeight)", gLocal: "=gTop - base - gS * storeyHeight",
        lintelTop: "=base + gS * storeyHeight + (gLocal <= 0.001 ? 0 : gLocal <= sill ? sill : gLocal <= sill + windowHeight ? sill + windowHeight : storeyHeight)",
        atriumR: "=radius * atrium", coreR: "=min(2.2, radius * atrium * 0.45)",
        yMax: "=spring + (rise - wall) * sqrt(max(0, 1 - pow((radius * atrium + 1.6) / ri, 2)))",
        topDeck: "=decks ? clamp(floor((yMax - base) / storeyHeight + 0.0001), 0, storeys - 1) : 0",
        coreTop: "=base + topDeck * storeyHeight + 3",
        lanternY: "=decks && core ? coreTop + 1.6 : spring + 1.6",
        gateZ: "=sqrt(rm * rm - gateWidth * gateWidth / 4)",
        pylonX: "=gateWidth / 2 + 0.8", pylonZ: "=sqrt(max(0, rm * rm - pylonX * pylonX)) + 0.35",
        apex: "=base + H + (oculus > 0.02 ? 1.6 : 0)",
        pierW: "=radius * rad(360 / windowsPerStorey) - windowWidth",
    },
    rules: [
        { check: "=pierW >= 0.9", message: "Too many windows: the piers between them are under 0.9 m wide." },
        { check: "=gateHeight <= drumH - 0.8", message: "The gate is taller than the drum." },
        { check: "=storeyHeight - sill - windowHeight >= 0.4", message: "No room for a floor over the windows." },
    ],
    regions: {
        shell: { label: "Shell panels", material: "=shellFinish" },
        panelAlt: { label: "Odd panels", material: "=patchFinish" },
        frame: { label: "Ribs and steel", material: "=frameFinish" },
        walls: { label: "Drum", material: "=wallFinish" },
        trim: { label: "Ledges and gate", material: "=trimFinish" },
        doors: { label: "Blast doors", material: "=doorFinish" },
        hazard: { label: "Hazard stripes", material: "paint.signal" },
        floor: { label: "Floors", material: "=floorFinish" },
        glass: { label: "Glass", material: "=glassFinish" },
        boards: { label: "Boards", material: "=boardFinish" },
        lit: { label: "Lit windows", material: "=litFinish" },
        beacon: { label: "Beacon light", material: "=beaconFinish" },
        lamp: { label: "Floodlights", material: "glow.warmWhite" },
    },
    presets: [
        { name: "Last sanctuary", values: {} },
        { name: "Irradiated reactor", values: { storeys: 6, drumStoreys: 2, radius: 16, missingPanels: 0.35, breach: 60, brokenPanes: 0.8, boarded: 0.05, litWindows: 0, doorOpen: 0.15, shellFinish: "metal.rustYellow", patchFinish: "metal.rust", beaconFinish: "glow.green", glassFinish: "glass.frosted", seed: 7 } },
        { name: "Sealed vault", values: { storeys: 4, drumStoreys: 2, radius: 11, missingPanels: 0, brokenPanes: 0.1, boarded: 0.7, litWindows: 0, doorOpen: 0, oculus: 0, lantern: false, shellFinish: "metal.black", patchFinish: "metal.rust", doorFinish: "metal.rust", beaconFinish: "glow.red", gateHeight: 3.2, gateWidth: 4 } },
        { name: "Collapsed ark", values: { storeys: 5, drumStoreys: 3, radius: 18, missingPanels: 0.55, breach: 200, brokenPanes: 0.9, boarded: 0.2, litWindows: 0, doorOpen: 0.8, beacon: false, floodlights: false, shellFinish: "metal.corrugatedRust", patchFinish: "metal.rustRed", seed: 23 } },
        { name: "Signal citadel", values: { storeys: 8, drumStoreys: 3, radius: 13, storeyHeight: 3.4, missingPanels: 0.1, litWindows: 0.25, brokenPanes: 0.3, oculus: 0.16, mastHeight: 10, buttresses: 12, shellFinish: "metal.copper", patchFinish: "metal.rust", beaconFinish: "glow.red", litFinish: "glow.cyan", seed: 5 } },
    ],
    nodes: [
        // ================= Ground =================
        { id: "slab", type: "mesh.cylinder", radius: "=radius + 1.6", height: "=base", segments: 96, region: "floor" },
        { id: "apron", type: "mesh.box", size: ["=gateWidth + 5", "=base", 5], at: [0, "=base / 2", "=radius + 2.5"], region: "floor" },

        // ================= Drum =================
        { id: "ringGate", type: "curve.sector", output: false, inner: "=ri", outer: "=radius", start: "=90 + gh", end: "=450 - gh", radius: 0, segments: 120 },
        { id: "gateSector", type: "curve.sector", output: false, inner: "=ri", outer: "=radius", start: "=90 - gh", end: "=90 + gh", radius: 0, segments: 12 },
        // Sill and head bands of every storey: whole rings, or cut by the gate where they reach below its top.
        { id: "bandsGated", type: "mesh.extrude", repeat: "=drumStoreys * 2", keep: `=${BY} < gTop - 0.001`, outline: "@ringGate", height: `=${BH}`, at: [0, `=${BY}`, 0], region: "walls" },
        { id: "bandsFull", type: "mesh.lathe", repeat: "=drumStoreys * 2", keep: `=${BY} >= gTop - 0.001`, segments: 120, smoothAngle: 30, region: "walls",
            profile: [["=ri", `=${BY}`], ["=radius", `=${BY}`], ["=radius", `=${BY} + ${BH}`], ["=ri", `=${BY} + ${BH}`], ["=ri", `=${BY}`]] },
        // Window bands: a pier between each pair of windows, so every opening is real.
        { id: "piers", type: "mesh.extrude", repeat: "=drumStoreys * windowsPerStorey", keep: `=${PIER_END} - ${PIER_START} > 0.05`,
            outline: sector(`90 + ${PIER_START}`, `90 + ${PIER_END}`, "ri", "radius", 4), height: "=windowHeight", at: [0, `=base + ${S} * sh + sill`, 0], region: "walls" },
        // Over the gate: wall from its top to the next band line.
        { id: "lintelFill", type: "mesh.extrude", when: "=lintelTop - gTop > 0.01", outline: "@gateSector", height: "=lintelTop - gTop", at: [0, "=gTop", 0], region: "walls" },
        { id: "cornice", type: "mesh.lathe", segments: 120, smoothAngle: 30, region: "trim",
            profile: [["=ri - 0.05", "=spring - 0.35"], ["=radius + 0.45", "=spring - 0.35"], ["=radius + 0.45", "=spring + 0.12"], ["=ri - 0.05", "=spring + 0.12"], ["=ri - 0.05", "=spring - 0.35"]] },
        // Ledges at the storey lines (cut where the gate passes).
        { id: "ledgeRingGate", type: "curve.sector", output: false, inner: "=radius - 0.02", outer: "=radius + 0.22", start: "=90 + gh", end: "=450 - gh", radius: 0, segments: 120 },
        { id: "ledgesGated", type: "mesh.extrude", when: "=ledges", repeat: "=drumStoreys - 1", keep: "=base + (index + 1) * sh < gTop + 0.3", outline: "@ledgeRingGate", height: 0.22, at: [0, "=base + (index + 1) * sh - 0.11", 0], region: "trim" },
        { id: "ledgesFull", type: "mesh.lathe", when: "=ledges", repeat: "=drumStoreys - 1", keep: "=base + (index + 1) * sh >= gTop + 0.3", segments: 120, smoothAngle: 30, region: "trim",
            profile: [["=radius - 0.02", "=base + (index + 1) * sh - 0.11"], ["=radius + 0.22", "=base + (index + 1) * sh - 0.11"], ["=radius + 0.22", "=base + (index + 1) * sh + 0.11"], ["=radius - 0.02", "=base + (index + 1) * sh + 0.11"], ["=radius - 0.02", "=base + (index + 1) * sh - 0.11"]] },
        // Windows: sills, glass (unless broken), lit panes, boards.
        { id: "sills", type: "mesh.box", repeat: "=drumStoreys * windowsPerStorey", keep: `=${WINDOW_OPEN}`, size: ["=windowWidth + 0.2", 0.1, 0.32],
            rotate: [0, `=90 - ${WB}`, 0], at: [`=(radius + 0.08) * cos(rad(${WB}))`, `=base + ${S} * sh + sill - 0.05`, `=(radius + 0.08) * sin(rad(${WB}))`], region: "trim" },
        { id: "panes", type: "mesh.box", repeat: "=drumStoreys * windowsPerStorey", keep: `=${WINDOW_OPEN} && !(${BROKEN})`, size: ["=windowWidth * 0.98", "=windowHeight * 0.98", 0.03],
            rotate: [0, `=90 - ${WB}`, 0], at: [`=rm * cos(rad(${WB}))`, `=base + ${S} * sh + sill + windowHeight / 2`, `=rm * sin(rad(${WB}))`], region: `=${LIT} ? 'lit' : 'glass'` },
        { id: "mullions", type: "mesh.box", repeat: "=drumStoreys * windowsPerStorey", keep: `=${WINDOW_OPEN} && !(${BROKEN})`, size: [0.06, "=windowHeight", 0.08],
            rotate: [0, `=90 - ${WB}`, 0], at: [`=(rm + 0.03) * cos(rad(${WB}))`, `=base + ${S} * sh + sill + windowHeight / 2`, `=(rm + 0.03) * sin(rad(${WB}))`], region: "frame" },
        { id: "boards", type: "mesh.box", repeat: "=drumStoreys * windowsPerStorey * 3", size: ["=windowWidth + 0.34", "=windowHeight * 0.2", 0.05],
            keep: `=!(${BAND_GATED.replace(/index/g, "floor(index / 3)")} && ${inGate(K.replace(/index/g, "floor(index / 3)"))}) && !(rand(floor(index / 3), 21) < litWindows) && rand(floor(index / 3), 22) < boarded && rand(index, 24) > 0.12`,
            rotate: [0, `=90 - ${WB.replace(/index/g, "floor(index / 3)")}`, 0],
            at: [`=(radius + 0.04) * cos(rad(${WB.replace(/index/g, "floor(index / 3)")}))`, `=base + ${S.replace(/index/g, "floor(index / 3)")} * sh + sill + windowHeight * (0.2 + 0.3 * (index % 3) + (rand(index, 25) - 0.5) * 0.08)`, `=(radius + 0.04) * sin(rad(${WB.replace(/index/g, "floor(index / 3)")}))`],
            region: "boards" },
        // Buttresses stand on piers, never over a window, and keep clear of the gate.
        { id: "buttressBottom", type: "curve.points", output: false, closed: true, points: [["=radius - 0.1", -0.45], ["=radius + 2.2", -0.45], ["=radius + 2.2", 0.45], ["=radius - 0.1", 0.45]] },
        { id: "buttressTop", type: "curve.points", output: false, closed: true, points: [["=radius - 0.1", -0.35], ["=radius + 0.35", -0.35], ["=radius + 0.35", 0.35], ["=radius - 0.1", 0.35]] },
        { id: "buttressArr", type: "mesh.loft", repeat: "=buttresses", bottom: "@buttressBottom", top: "@buttressTop", height: "=spring + 0.4",
            keep: "=(floor((index + 0.5) * windowsPerStorey / count) + 0.5) * step > gh + 4 && (floor((index + 0.5) * windowsPerStorey / count) + 0.5) * step < 356 - gh",
            rotate: [0, "=-(90 + (floor((index + 0.5) * windowsPerStorey / count) + 0.5) * step)", 0], region: "trim" },

        // ================= Gate =================
        { id: "pylons", type: "mesh.box", repeat: 2, size: [1.6, "=base + gateHeight + 1.6", "=wall + 1.4"], at: ["=(index == 0 ? -1 : 1) * pylonX", "=(base + gateHeight + 1.6) / 2", "=pylonZ"], region: "trim" },
        { id: "lintel", type: "mesh.box", size: ["=gateWidth + 3.6", 1.3, "=wall + 1.6"], at: [0, "=gTop + 0.65", "=gateZ + 0.3"], region: "trim" },
        { id: "lintelStripe", type: "mesh.box", size: ["=gateWidth + 3.4", 0.28, 0.06], at: [0, "=gTop + 0.65", "=gateZ + 1.12"], region: "hazard" },
        { id: "blastDoors", type: "mesh.box", repeat: 2, size: ["=gateWidth / 2 + 0.25", "=gateHeight", 0.3],
            at: ["=(index == 0 ? -1 : 1) * (gateWidth / 4 + 0.125 + doorOpen * gateWidth / 2)", "=base + gateHeight / 2", "=gateZ"], region: "doors" },
        { id: "doorRibs", type: "mesh.box", repeat: 8, size: ["=gateWidth / 2 + 0.1", 0.14, 0.1],
            at: ["=(index % 2 == 0 ? -1 : 1) * (gateWidth / 4 + 0.125 + doorOpen * gateWidth / 2)", "=base + gateHeight * (0.14 + 0.24 * floor(index / 2))", "=gateZ + 0.19"], region: "frame" },
        { id: "doorStripes", type: "mesh.box", repeat: 2, size: ["=gateWidth / 2 + 0.2", 0.36, 0.04],
            at: ["=(index == 0 ? -1 : 1) * (gateWidth / 4 + 0.125 + doorOpen * gateWidth / 2)", "=base + gateHeight * 0.5", "=gateZ + 0.17"], region: "hazard" },
        { id: "floodHousings", type: "mesh.box", when: "=floodlights", repeat: 2, size: [0.7, 0.4, 0.45], rotate: [-28, 0, 0],
            at: ["=(index == 0 ? -1 : 1) * pylonX", "=gTop + 1.6", "=pylonZ + (wall + 1.4) / 2 + 0.2"], region: "frame" },
        { id: "floodLenses", type: "mesh.box", when: "=floodlights", repeat: 2, size: [0.56, 0.06, 0.32], rotate: [-28, 0, 0],
            at: ["=(index == 0 ? -1 : 1) * pylonX", "=gTop + 1.6 - 0.2", "=pylonZ + (wall + 1.4) / 2 + 0.27"], region: "lamp" },

        // ================= Shell =================
        { id: "panels", type: "mesh.lathe", when: "=roofVisible", repeat: "=panelRings * panelSectors", keep: `=${PANEL_KEPT}`,
            profile: panelProfile, segments: 4, sweep: `=${PANEL_SWEEP}`, smoothAngle: 50,
            rotate: [0, `=-(${Q} * 360 / panelSectors + (360 / panelSectors - ${PANEL_SWEEP}) / 2 + ${PANEL_SWEEP})`, 0],
            region: "=rand(index, 5) < 0.3 ? 'panelAlt' : 'shell'" },
        { id: "ribPath", type: "path.points", output: false, points: Array.from({ length: 13 }, (_, j) =>
            [`=rm * cos(crown * ${(j / 12).toFixed(4)})`, `=spring + (rise - wall / 2) * sin(crown * ${(j / 12).toFixed(4)})`, 0]) },
        { id: "meridians", type: "mesh.sweep", when: "=roofVisible && ribs", repeat: "=panelSectors", path: "@ribPath", radius: "=wall * 0.55", sides: 6,
            rotate: [0, "=-index * 360 / panelSectors", 0], region: "frame" },
        { id: "ringBeams", type: "mesh.torus", when: "=roofVisible && ribs", repeat: "=panelRings - 1", major: "=rm * cos(crown * (index + 1) / panelRings)", minor: "=wall * 0.5", segments: 120, sides: 6,
            at: [0, "=spring + (rise - wall / 2) * sin(crown * (index + 1) / panelRings)", 0], region: "frame" },
        { id: "crownRing", type: "mesh.torus", when: "=roofVisible && oculus > 0.02", major: "=rCrown", minor: "=wall * 0.9", segments: 64, sides: 8, at: [0, "=yCrown - wall * 0.3", 0], region: "frame" },
        { id: "springRing", type: "mesh.torus", when: "=roofVisible && ribs", major: "=rm", minor: "=wall * 0.6", segments: 120, sides: 6, at: [0, "=spring + 0.1", 0], region: "frame" },

        // ================= Decks and core =================
        { id: "deckRings", type: "mesh.extrude", when: "=decks", repeat: "=storeys - 1", keep: "=index + 1 <= topDeck",
            outline: { if: `=${DECK_LOBBY}`, then: sector("90 + gh + 12", "450 - gh - 12", "atriumR", DECK_OUT, 40), else: circle(DECK_OUT, 72) },
            holes: { if: `=${DECK_LOBBY}`, then: [], else: [circle("atriumR", 48)] },
            height: 0.3, at: [0, `=${DY} - 0.3`, 0], region: "floor" },
        { id: "handrails", type: "mesh.torus", when: "=decks", repeat: "=storeys - 1", keep: "=index + 1 <= topDeck", major: "=atriumR - 0.06", minor: 0.035, segments: 72, sides: 6,
            at: [0, `=${DY} + 1.05`, 0], region: "frame" },
        { id: "balusters", type: "mesh.cylinder", when: "=decks", repeat: "=(storeys - 1) * 28", keep: "=floor(index / 28) + 1 <= topDeck", radius: 0.025, height: 1.05, segments: 6,
            at: ["=(atriumR - 0.06) * cos(rad((index % 28) * 360 / 28 + 6))", "=base + (floor(index / 28) + 1) * sh", "=(atriumR - 0.06) * sin(rad((index % 28) * 360 / 28 + 6))"], region: "frame" },
        { id: "liftCore", type: "mesh.cylinder", when: "=decks && core", radius: "=coreR", height: "=coreTop - base", segments: 40, at: [0, "=base", 0], region: "walls" },
        { id: "coreCap", type: "mesh.cylinder", when: "=decks && core", radius: "=coreR + 0.25", height: 0.3, segments: 40, bevel: 0.05, at: [0, "=coreTop", 0], region: "trim" },
        { id: "bridges", type: "mesh.box", when: "=decks && core", repeat: "=topDeck * 2", size: ["=atriumR - coreR + 0.3", 0.25, 1.6],
            at: ["=(index % 2 == 0 ? 1 : -1) * (coreR + atriumR) / 2", "=base + (floor(index / 2) + 1) * sh - 0.125", 0], region: "floor" },
        { id: "liftDoors", type: "mesh.box", when: "=decks && core", repeat: "=(topDeck + 1) * 2", size: [0.12, 2.2, 1.2],
            at: ["=(index % 2 == 0 ? 1 : -1) * (coreR + 0.02)", "=base + floor(index / 2) * sh + 1.1", 0], region: "doors" },
        { id: "liftLamps", type: "mesh.box", when: "=decks && core", repeat: "=(topDeck + 1) * 2", size: [0.08, 0.1, 0.5],
            at: ["=(index % 2 == 0 ? 1 : -1) * (coreR + 0.04)", "=base + floor(index / 2) * sh + 2.45", 0], region: "lit" },

        // ================= Beacon =================
        { id: "lanternCable", type: "mesh.cylinder", when: "=lantern && lanternY + 1.2 < yCrown - 0.4", radius: 0.03, height: "=yCrown - lanternY - 0.9", segments: 6, at: [0, "=lanternY + 0.9", 0], region: "frame" },
        { id: "lanternGlow", type: "mesh.icosphere", when: "=lantern && lanternY + 1.2 < yCrown - 0.4", radius: 0.75, subdivisions: 2, at: [0, "=lanternY", 0], region: "beacon" },
        { id: "lanternCage", type: "mesh.torus", when: "=lantern && lanternY + 1.2 < yCrown - 0.4", repeat: 3, major: 0.88, minor: 0.035, segments: 32, sides: 6,
            rotate: [90, "=index * 60", 0], at: [0, "=lanternY", 0], region: "frame" },
        { id: "tripodPath", type: "path.points", output: false, points: [["=rCrown", "=yCrown", 0], [0, "=apex", 0]] },
        { id: "tripod", type: "mesh.sweep", when: "=roofVisible && beacon && oculus > 0.02", repeat: 3, path: "@tripodPath", radius: 0.09, sides: 6, rotate: [0, "=index * 120 + 30", 0], region: "frame" },
        { id: "mast", type: "mesh.cone", when: "=roofVisible && beacon", bottomRadius: 0.16, topRadius: 0.07, height: "=mastHeight", segments: 10, at: [0, "=apex - 0.1", 0], region: "frame" },
        { id: "spars", type: "mesh.box", when: "=roofVisible && beacon", repeat: 3, size: ["=1.6 - index * 0.4", 0.07, 0.07], rotate: [0, "=index * 55", 0], at: [0, "=apex + mastHeight * (0.35 + index * 0.2)", 0], region: "frame" },
        { id: "beaconLight", type: "mesh.icosphere", when: "=roofVisible && beacon", radius: 0.3, subdivisions: 2, at: [0, "=apex + mastHeight + 0.15", 0], region: "beacon" },
        { id: "beaconHalo", type: "mesh.torus", when: "=roofVisible && beacon && oculus > 0.02", major: "=rCrown - 0.2", minor: 0.08, segments: 64, sides: 6, at: [0, "=yCrown + 0.25", 0], region: "beacon" },
    ],
    limits: { maxSize: 60, minSize: 10, maxTriangles: 200000 },
};

export default rustDomeDef;
