import type { SceneDef } from "../mesha_scene_def";

// "The Road to the Dome": a level-sized stretch of wasteland for one chapter of a story. You start
// at the south edge (+Z) on a cracked highway; pass a dead warning sign and a container checkpoint
// with one gap; walk a corridor of wrecked cars between ruined walls, a scavenger outpost (the
// Wasteland Depot) and a line of leaning utility poles; and arrive on a cracked plaza ringed by
// rusted lamps and railings, before the gate of a five-storey Rust Dome whose beacon you could see
// the whole way. Everything is a library object: change the scene's controls to rebuild it, or
// select any one piece and shape it on its own.
//
//      -Z  +-------------------------------+   the dome (gate facing the road), plaza, lamps
//          |          .--'''--.            |
//          |         (  DOME   )           |
//          |      o   '--[ ]--'   o        |   railings either side of the road
//          |   ===|=====|   |=====|===     |
//          |  ruin      | . |  [outpost]   |   wrecks weave along the road; ruins one side,
//          |  ruin   car|   |car  [depot]  |   the depot the other; poles down one verge
//          |  ruin      |car|              |
//          |  ===[cont][cont]  gap [cont]  |   the checkpoint
//          |  sign      |   |              |
//      +Z  +-------------------------------+   start
//
// Distances are in metres; the road runs along Z at x = 0. The level's own seed drives every
// rand(), so a new seed is a new arrangement with the same story beats.

/** Shared expressions. Car i's z, so its height can follow the plaza. */
const CAR_Z = "lerp(cpZ - 5, plazaFront - 3, (index + 0.5) / count) + (rand(index, 40) - 0.5) * 2";
/** Ruin i: which side, and where along the road. */
const RUIN_SIDE = "(index % 3 == 2 ? side : -side)";
const RUIN_Z = "lerp(cpZ - 4, plazaFront + 4, (index + 0.5) / count) + (rand(index, 50) - 0.5) * 3";
/** Off-road scatter: a side, a distance out from the verge, a position along the level. */
const SCATTER_S = (salt: number) => `(rand(index, ${salt}) < 0.5 ? -1 : 1)`;
const outOfTheWay = (x: string, z: string) =>
    `!(outpost && (${x}) * side > verge && abs((${z}) - outZ) < 11) && hypot(${x}, (${z}) - plazaZ) > plazaR + 1.5 && abs(${x}) > verge + 0.4`;
const TREE_X = `${SCATTER_S(60)} * (width / 2 - 2 - rand(index, 61) * 8)`;
const TREE_Z = "length / 2 - 3 - rand(index, 62) * (length - 6)";
const GRASS_X = `${SCATTER_S(70)} * (verge + 0.6 + rand(index, 71) * (width / 2 - verge - 1.6))`;
const GRASS_Z = "length / 2 - 2 - rand(index, 72) * (length - 4)";
const ROCK_X = `${SCATTER_S(80)} * (verge + 1 + rand(index, 81) * (width / 2 - verge - 2))`;
const ROCK_Z = "length / 2 - 2 - rand(index, 82) * (length - 4)";

export const roadToTheDome: SceneDef = {
    id: "scene.road_to_the_dome",
    name: "The Road to the Dome",
    description: "A post-apocalyptic level: a cracked highway past a container checkpoint, wrecked cars, ruins, a scavenger outpost and sagging power lines to a five-storey rusting dome with a beacon.",
    tags: ["post-apocalyptic", "wasteland", "level", "road", "dome", "ruins", "rust", "eerie", "abandoned"],
    featured: ["length", "decay", "domeStoreys", "cars", "ruins", "outpost", "mood"],
    groups: [
        { id: "level", label: "Level" },
        { id: "destination", label: "The dome" },
        { id: "decay", label: "Decay" },
        { id: "wreckage", label: "Wreckage" },
        { id: "settlement", label: "Outpost" },
        { id: "ruins", label: "Ruins and lines" },
        { id: "nature", label: "Dead nature" },
        { id: "mood", label: "Mood" },
    ],
    params: [
        // --- Level ---
        { id: "length", label: "Level length", type: "number", default: 96, min: 72, max: 110, unit: "m", group: "level", description: "From the start (+Z) to behind the dome." },
        { id: "width", label: "Level width", type: "number", default: 56, min: 46, max: 80, unit: "m", group: "level" },
        { id: "roadWidth", label: "Road width", type: "number", default: 7.5, min: 6, max: 10, unit: "m", group: "level" },
        // --- Destination ---
        { id: "domeStoreys", label: "Dome storeys", type: "int", default: 5, min: 3, max: 8, group: "destination" },
        { id: "domeRadius", label: "Dome radius", type: "number", default: 14, min: 10, max: 17, unit: "m", group: "destination" },
        { id: "domeDecay", label: "Missing dome panels", type: "number", default: 0.22, min: 0, max: 0.6, group: "destination" },
        { id: "gateOpen", label: "Blast doors open", type: "number", default: 0.35, min: 0, max: 1, group: "destination" },
        { id: "beacon", label: "Beacon", type: "enum", default: "green", options: ["green", "red", "amber", "cyan"], optionLabels: ["Toxic green", "Warning red", "Amber", "Cold cyan"], group: "destination" },
        { id: "litWindows", label: "Lit dome windows", type: "number", default: 0.06, min: 0, max: 0.5, group: "destination", description: "Someone is still inside." },
        // --- Decay ---
        { id: "decay", label: "Decay", type: "number", default: 0.6, min: 0, max: 1, group: "decay", description: "How long the world has been gone: glass, wheels, roofs, walls and the road all follow it." },
        // --- Wreckage ---
        { id: "cars", label: "Wrecked cars", type: "int", default: 8, min: 0, max: 14, group: "wreckage" },
        { id: "checkpoint", label: "Container checkpoint", type: "bool", default: true, group: "wreckage" },
        { id: "barrels", label: "Barrel huddles", type: "int", default: 7, min: 0, max: 10, group: "wreckage" },
        // --- Outpost ---
        { id: "outpost", label: "Scavenger outpost", type: "bool", default: true, group: "settlement" },
        { id: "outpostSide", label: "Outpost side", type: "enum", default: "left", options: ["left", "right"], optionLabels: ["Left", "Right"], group: "settlement", visibleIf: "=outpost" },
        { id: "campfires", label: "Burn barrels lit", type: "bool", default: true, group: "settlement" },
        // --- Ruins and lines ---
        { id: "ruins", label: "Ruined walls", type: "int", default: 6, min: 0, max: 10, group: "ruins" },
        { id: "poles", label: "Utility poles", type: "bool", default: true, group: "ruins" },
        { id: "plazaLamps", label: "Plaza lamps", type: "int", default: 6, min: 0, max: 8, group: "ruins" },
        { id: "railings", label: "Plaza railings", type: "bool", default: true, group: "ruins" },
        // --- Dead nature ---
        { id: "deadTrees", label: "Dead trees", type: "int", default: 12, min: 0, max: 24, group: "nature" },
        { id: "grass", label: "Dry grass patches", type: "int", default: 24, min: 0, max: 40, group: "nature" },
        { id: "rocks", label: "Rocks", type: "int", default: 12, min: 0, max: 24, group: "nature" },
        // --- Mood ---
        { id: "mood", label: "Mood", type: "enum", default: "ashen", options: ["ashen", "toxic", "night"], optionLabels: ["Ashen dusk", "Toxic haze", "Dead of night"], group: "mood", variation: 0.5 },
        { id: "seed", label: "Seed", type: "seed", default: 1984, group: "mood", variation: 0 },
    ],
    derived: {
        verge: "=roadWidth / 2 + 2",
        side: "=outpostSide == 'left' ? -1 : 1",
        domeZ: "=-length / 2 + domeRadius + 6",
        plazaR: "=min(domeRadius + 5, width / 2 - 1)",
        plazaZ: "=-length / 2 + domeRadius + 8",
        plazaFront: "=-length / 2 + domeRadius + 8 + min(domeRadius + 5, width / 2 - 1)",
        cpZ: "=length / 2 - 20",
        outZ: "=(length / 2 - 20 + (-length / 2 + domeRadius + 8 + min(domeRadius + 5, width / 2 - 1))) / 2 + 1",
        outX: "=(outpostSide == 'left' ? -1 : 1) * min(roadWidth / 2 + 12.6, width / 2 - 9)",
        gapX: "=roadWidth / 2 - 1.8",
        poleCount: "=max(2, floor((length / 2 - 2 - (-length / 2 + domeRadius + 8 + min(domeRadius + 5, width / 2 - 1))) / 18) + 1)",
        poleSpan: "=(length / 2 - 2 - (-length / 2 + domeRadius + 8 + min(domeRadius + 5, width / 2 - 1) + 1)) / (max(2, floor((length / 2 - 2 - (-length / 2 + domeRadius + 8 + min(domeRadius + 5, width / 2 - 1))) / 18) + 1) - 1)",
        beaconGlow: "=beacon == 'red' ? 'glow.red' : beacon == 'amber' ? 'glow.amber' : beacon == 'cyan' ? 'glow.cyan' : 'glow.green'",
    },
    rules: [
        { check: "=cpZ - plazaFront > 18", message: "The level is too short for the road between the checkpoint and the plaza." },
    ],
    lighting: "=mood",
    presets: [
        { name: "Ashen approach", values: {} },
        { name: "Toxic exclusion zone", values: { mood: "toxic", decay: 0.85, domeDecay: 0.4, beacon: "green", cars: 11, ruins: 8, deadTrees: 18, grass: 12, gateOpen: 0.15, litWindows: 0, seed: 77 } },
        { name: "Night pilgrimage", values: { mood: "night", decay: 0.5, beacon: "red", litWindows: 0.2, gateOpen: 0.6, campfires: true, cars: 6, plazaLamps: 8, seed: 31 } },
        { name: "Fresh collapse", values: { decay: 0.2, domeDecay: 0.05, cars: 13, barrels: 4, ruins: 3, deadTrees: 6, grass: 30, beacon: "amber", seed: 5 } },
        { name: "Long road", values: { length: 110, width: 50, domeStoreys: 7, domeRadius: 12, cars: 12, ruins: 9, outpostSide: "right", seed: 404 } },
    ],
    placements: [
        // ================= Ground =================
        {
            id: "ground", object: "street.wasteland_ground", label: "Ground", at: [0, 0, 0],
            params: {
                width: "=width", length: "=length", roadWidth: "=roadWidth", sidewalkWidth: 2, bumps: 0.5,
                cracks: "=0.35 + decay * 0.55", potholes: "=0.25 + decay * 0.65", puddles: 0.55, brokenPaving: "=0.15 + decay * 0.6",
                plazaRadius: "=plazaR", plazaZ: "=plazaZ",
                waterFinish: "=mood == 'toxic' ? 'glow.toxic' : 'water.toxic'", groundFinish: "=mood == 'toxic' ? 'ground.rubble' : 'ground.ash'",
            },
        },
        // ================= The destination =================
        {
            id: "dome", object: "architecture.rust_dome", label: "The Dome", at: [0, 0, "=domeZ"],
            params: {
                storeys: "=domeStoreys", radius: "=domeRadius", drumStoreys: "=domeStoreys >= 6 ? 3 : 2", missingPanels: "=domeDecay",
                brokenPanes: "=0.2 + decay * 0.65", boarded: "=0.1 + decay * 0.15", litWindows: "=litWindows", doorOpen: "=gateOpen",
                beaconFinish: "=beaconGlow", breach: 125, buttresses: 8,
            },
        },
        // ================= Start: a dead warning sign and the first wreck =================
        {
            id: "warningSign", object: "street.streetlight", label: "Warning sign", at: ["=verge + 0.8", 0, "=length / 2 - 6"], turn: -15,
            params: { kind: "sign", signShape: "triangle", signSize: 0.9, height: 2.6, poleStyle: "square", poleFinish: "metal.rust", signFinish: "paint.signal", faceFinish: "paint.crimson" },
        },
        {
            id: "firstWreck", object: "transport.wreck_car", label: "Overturned wreck", at: ["=-verge - 1.5", 0, "=length / 2 - 9"], turn: 70,
            params: { style: "sedan", missingWheels: 2, brokenGlass: 1, roll: -14, sink: 0.12, bodyFinish: "metal.rust", hoodOpen: 40 },
        },
        // ================= The checkpoint =================
        {
            id: "cpLeft", object: "transport.container", label: "Checkpoint container", when: "=checkpoint", at: ["=gapX - 1.6 - 3.1", 0.14, "=cpZ"], turn: "=90 + (rand(1, 90) - 0.5) * 6",
            params: { size: "20", doorsOpen: 0, missingPanels: "=decay * 0.12", shellFinish: "metal.corrugatedRust" },
        },
        {
            id: "cpStack", object: "transport.container", label: "Stacked containers", when: "=checkpoint", at: ["=gapX - 1.6 - 6.06 - 3.4", 0, "=cpZ - 0.4"], turn: "=90 + (rand(2, 90) - 0.5) * 8",
            params: { size: "20", stack: 2, doorsOpen: 0.2, missingPanels: "=decay * 0.1", shellFinish: "metal.corrugatedRed", doorFinish: "metal.corrugatedRust" },
        },
        {
            id: "cpRight", object: "transport.container", label: "Tipped container", when: "=checkpoint", at: ["=gapX + 1.6 + 3.03 + 0.3", 0.14, "=cpZ - 0.4"], turn: "=90 + (rand(3, 90) - 0.5) * 6",
            params: { size: "20", roll: "=decay > 0.45 ? 90 : 0", doorsOpen: 0.5, missingPanels: "=decay * 0.2", shellFinish: "metal.corrugatedGreen" },
        },
        // ================= The road: wrecks weaving lane to lane =================
        {
            id: "wrecks", object: "transport.wreck_car", label: "Wreck", repeat: "=cars",
            at: ["=(index % 2 == 0 ? -1 : 1) * (0.9 + rand(index, 41) * (roadWidth / 2 - 1.9))", `=(${CAR_Z}) < plazaFront - 0.5 ? 0.2 : 0.14`, `=${CAR_Z}`],
            turn: "=(rand(index, 42) < 0.5 ? 0 : 180) + (rand(index, 43) - 0.5) * 70",
            params: {
                style: "=select(floor(rand(index, 44) * 4), 'sedan', 'hatchback', 'pickup', 'van')",
                length: "=lerp(3.9, 5.1, rand(index, 45))",
                missingWheels: "=floor(rand(index, 46) * decay * 4.99)",
                flatTyres: "=rand(index, 47) < 0.35 + decay * 0.5",
                brokenGlass: "=clamp(decay * (0.5 + rand(index, 48) * 0.7), 0, 1)",
                hoodOpen: "=rand(index, 49) < decay * 0.4 ? 25 + rand(index, 30) * 40 : 0",
                burnt: "=rand(index, 31) < decay * 0.28",
                roll: "=(rand(index, 32) - 0.5) * 8 * decay",
                sink: "=decay * 0.1 * rand(index, 33)",
                salvagedDoor: "=rand(index, 34) < 0.3",
                roofLoad: "=rand(index, 35) < 0.15",
                bodyFinish: "=select(floor(rand(index, 36) * 7), 'metal.rustRed', 'metal.rust', 'metal.rustYellow', 'paint.sage', 'paint.navy', 'paint.cream', 'paint.teal')",
            },
        },
        // ================= The outpost =================
        {
            id: "depot", object: "architecture.wasteland_depot", label: "Scavenger outpost", when: "=outpost", at: ["=outX", 0, "=outZ"], turn: "=side < 0 ? 90 : -90",
            params: {
                width: 11, bays: 3, bayLength: 4.4, eave: 5.2, towerHeight: 8.5, rollerOpen: "=0.25 + (1 - decay) * 0.3",
                roofDamage: "=0.1 + decay * 0.4", brokenPanes: "=0.2 + decay * 0.6", boarded: 0.4, patches: 0.45, offices: 2, mezzDepth: 3.5,
                lampFinish: "=campfires ? 'glow.amber' : 'glow.red'",
            },
        },
        {
            id: "outpostCrates", object: "household.crate", label: "Salvage crates", when: "=outpost", repeat: 2, preset: "Shipping crate",
            at: ["=outX - side * (8.6 + rand(index, 91) * 1.2)", 0, "=outZ - 6.2 - index * 0.95"], turn: "=rand(index, 92) * 40 - 20",
            params: { woodFinish: "wood.weathered", wear: "=0.3 + decay * 0.6" },
        },
        {
            id: "outpostContainer", object: "transport.container", label: "Outpost store", when: "=outpost", at: ["=outX + side * 2", 0, "=outZ - 11"], turn: "=side < 0 ? 0 : 180",
            params: { size: "20", doorsOpen: 0.7, cutDoor: true, missingPanels: "=decay * 0.1", shellFinish: "metal.corrugatedGreen", doorFinish: "metal.corrugatedRust" },
        },
        // ================= Ruins =================
        {
            id: "ruinWalls", object: "architecture.ruin", label: "Ruined wall", repeat: "=ruins",
            keep: `=!(outpost && ${RUIN_SIDE} == side && abs((${RUIN_Z}) - outZ) < 13)`,
            at: [`=${RUIN_SIDE} * (verge + 1.6 + rand(index, 51) * 3)`, 0, `=${RUIN_Z}`], turn: `=${RUIN_SIDE} > 0 ? -90 : 90`,
            params: {
                length: "=5 + rand(index, 52) * 6", height: "=3 + rand(index, 53) * 4", ruin: "=0.3 + decay * 0.5 + rand(index, 54) * 0.15",
                openings: "=floor(rand(index, 55) * 3)", rubble: "=0.4 + decay * 0.5", returnWall: "=rand(index, 56) < 0.5 ? 2 + rand(index, 57) * 3 : 0",
                wallFinish: "=select(floor(rand(index, 58) * 4), 'masonry.brick', 'masonry.buff', 'masonry.darkConcrete', 'masonry.brick')",
            },
        },
        {
            id: "plazaFacades", object: "architecture.ruin", label: "Gutted facade", repeat: 2, keep: "=width / 2 - plazaR > 5",
            at: ["=(index == 0 ? -1 : 1) * (plazaR + 2.5)", 0, "=plazaZ + 2"], turn: "=index == 0 ? 90 : -90",
            params: { length: 14, height: 7.5, ruin: "=0.25 + decay * 0.35", openings: 4, openingWidth: 1.4, returnWall: 3, rubble: 0.7, wallFinish: "masonry.buff" },
        },
        // ================= Power lines down the far verge =================
        {
            id: "poles", object: "street.utility_pole", label: "Utility pole", when: "=poles", repeat: "=poleCount",
            at: ["=-side * (verge + 0.8)", 0, "=length / 2 - 2 - index * poleSpan"], turn: 90,
            params: {
                span: "=poleSpan", wires: "=index < count - 1", height: 9, lean: "=(rand(index, 93) - 0.5) * 2 * (2 + decay * 12) * -side",
                sag: "=0.8 + decay * 1.4", snapped: "=rand(index, 94) < decay * 0.5", brokenArm: "=rand(index, 95) < decay * 0.4", lamp: true, lampLit: false,
            },
        },
        // ================= The plaza =================
        {
            id: "lamps", object: "street.streetlight", label: "Plaza lamp", repeat: "=plazaLamps",
            keep: "=abs(cos(rad(lerp(28, 152, t))) * (plazaR - 1.4)) > roadWidth / 2 + 1",
            at: ["=cos(rad(lerp(28, 152, t))) * (plazaR - 1.4)", 0.2, "=plazaZ + sin(rad(lerp(28, 152, t))) * (plazaR - 1.4)"],
            turn: "=90 - lerp(28, 152, t) + 180",
            params: { kind: "light", poleStyle: "heritage", height: 4.6, arms: 1, armStyle: "scroll", fitting: "lantern", poleFinish: "metal.rust", lit: "=index == 1 || rand(index, 96) < 0.12", lampFinish: "glow.amber" },
        },
        {
            id: "rails", object: "architecture.fence", label: "Plaza railing", when: "=railings", repeat: 2,
            at: ["=(index == 0 ? -1 : 1) * (roadWidth / 2 + 1.2 + (plazaR * 0.7 - roadWidth / 2 - 1.2) / 2)", 0.2, "=plazaZ + plazaR * 0.72"],
            params: {
                length: "=plazaR * 0.7 - roadWidth / 2 - 1.2", height: 1.4, infillStyle: "iron", barPitch: 0.2, postStyle: "ball", gate: "=index == 1", gateOpen: 70,
                infillFinish: "metal.rust", frameFinish: "metal.rust",
            },
        },
        // ================= Barrel huddles at the story beats =================
        {
            id: "barrelHuddles", object: "street.barrel", label: "Barrels", repeat: "=barrels",
            at: [
                "=[gapX - 2.4, gapX + 2.6, -verge - 0.5, outX - side * 8.4, verge + 2.2, -plazaR * 0.45, plazaR * 0.5, verge + 1.4, -verge - 1.2, 2.5][index]",
                "=index == 0 || index == 1 ? 0.14 : index == 5 || index == 6 ? 0.2 : 0",
                "=[cpZ + 2.2, cpZ + 1.8, length / 2 - 13, outZ + 6.5, (cpZ + plazaFront) / 2 - 3, plazaZ + plazaR * 0.55, plazaZ + plazaR * 0.4, cpZ - 9, plazaFront + 5, length / 2 - 4][index]",
            ],
            turn: "=rand(index, 97) * 360",
            params: {
                kind: "=index == 3 || index == 4 || index == 8 ? 'burn' : 'drum'", fire: "=campfires", count: "=[3, 2, 1, 2, 1, 4, 3, 2, 1, 1][index]", tipped: "=0.15 + decay * 0.4",
                dents: "=0.2 + decay * 0.6", spread: 1.2,
                drumFinish: "=index == 3 || index == 4 || index == 8 ? 'metal.rustDark' : select(floor(rand(index, 98) * 4), 'metal.rustRed', 'metal.rustYellow', 'metal.rust', 'paint.navy')",
            },
        },
        // ================= Dead nature =================
        {
            id: "trees", object: "nature.tree", label: "Dead tree", repeat: "=deadTrees", keep: `=${outOfTheWay(TREE_X, TREE_Z)}`,
            at: [`=${TREE_X}`, 0, `=${TREE_Z}`], turn: "=rand(index, 63) * 360",
            params: {
                canopy: "bare", height: "=4.5 + rand(index, 64) * 5", trunkRadius: "=0.14 + rand(index, 65) * 0.14", gnarl: "=0.55 + rand(index, 66) * 0.4",
                lean: "=rand(index, 67) * 9", levels: 3, limbs: "=4 + floor(rand(index, 68) * 3)", twigs: 3, droop: 0.15,
                barkFinish: "=rand(index, 69) < 0.5 ? 'bark.dark' : 'bark.grey'",
            },
        },
        {
            id: "dryGrass", object: "nature.grass", label: "Dry grass", repeat: "=grass", keep: `=${outOfTheWay(GRASS_X, GRASS_Z)}`,
            at: [`=${GRASS_X}`, 0, `=${GRASS_Z}`], turn: "=rand(index, 73) * 360",
            params: {
                clumps: "=5 + floor(rand(index, 74) * 9)", patchRadius: "=0.9 + rand(index, 75) * 1.6", blades: 20, height: "=0.35 + rand(index, 76) * 0.45",
                lean: 34, curl: 70, tipTint: 0.5, grassFinish: "grass.dry", plumes: "=floor(rand(index, 77) * 3)", plumeFinish: "flower.cream",
            },
        },
        {
            id: "rocks", object: "nature.rock", label: "Rocks", repeat: "=rocks", keep: `=${outOfTheWay(ROCK_X, ROCK_Z)}`,
            at: [`=${ROCK_X}`, 0, `=${ROCK_Z}`], turn: "=rand(index, 83) * 360",
            params: { size: "=0.4 + rand(index, 84) * 1.1", count: "=1 + floor(rand(index, 85) * 4)", roughness: 0.3, faceted: true, stone: "=rand(index, 86) < 0.5 ? 'stone.slate' : 'stone.granite'" },
        },
    ],
};

export default roadToTheDome;
