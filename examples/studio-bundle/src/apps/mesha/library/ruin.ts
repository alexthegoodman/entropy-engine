import type { ObjectDef } from "../mesha_object";

// What is left of a building's wall: block courses laid in running bond along X (the wall's face
// toward +Z), broken down to a ragged top. The top line is a seeded mix of slow and fast waves plus
// per-column chips, so Ruin goes from a few lost blocks to a stump; shell holes knock out single
// blocks; window openings are real gaps with a lintel. Around it: a remnant floor slab with its
// rebar, rods sticking out of the broken top, a return wall at one end and a rubble pile.

/** Column and course of block `index` in a repeat over cols * courses. */
const COL = "(index % cols)", ROW = "floor(index / cols)";
/** Bond: odd courses shift half a block, so their ends come out toothed. */
const U = `(-length / 2 + (${COL} + (${ROW} % 2 == 1 ? 1 : 0.5)) * block)`;
/** Height the wall still stands to at u. */
const top = (u: string) => `max(height * 0.14, height * (1 - ruin * (0.5 * (0.5 + 0.5 * sin((${u}) * 0.55 + rand(1, 1) * 6.28)) + 0.3 * (0.5 + 0.5 * sin((${u}) * 1.7 + rand(2, 1) * 6.28)) + 0.25 * rand(floor((${u}) / block + 100), 5))))`;
/** Window k's centre. */
const OU = (k: string) => `((${k} + 1) * length / (openings + 1) - length / 2)`;
const inOpening = (u: string, y: string) =>
    `(openings > 0 && (${y}) > sillY - 0.001 && (${y}) < headY + 0.001 && abs((${u}) - ${OU(`max(0, min(openings - 1, round(((${u}) + length / 2) * (openings + 1) / length - 1)))`)}) < openingWidth / 2 + block * 0.25)`;

/** Same, for the return wall (along Z at the +X end), with its own columns. */
const RCOL = "(index % rcols)", RROW = "floor(index / rcols)";
const RU = `((${RCOL} + (${RROW} % 2 == 1 ? 1 : 0.5)) * block)`;

export const ruinDef: ObjectDef = {
    id: "architecture.ruin",
    name: "Ruined Wall",
    category: "Architecture",
    tags: ["ruin", "ruined", "wall", "rubble", "debris", "bombed", "broken", "collapsed", "masonry", "brick", "concrete", "blocks", "rebar", "post-apocalyptic", "apocalyptic", "wasteland", "war", "abandoned", "remains"],
    description: "A broken masonry wall: brick or block courses down to a ragged top, shell holes, empty window openings, a return wall, a remnant floor slab with rebar and a rubble pile.",
    featured: ["length", "height", "ruin", "openings", "rubble", "slab", "wallFinish"],
    groups: [
        { id: "wall", label: "Wall" },
        { id: "damage", label: "Damage" },
        { id: "remains", label: "Remains" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "length", label: "Length", type: "number", default: 9, min: 3, max: 16, unit: "m", group: "wall" },
        { id: "height", label: "Original height", type: "number", default: 5.5, min: 1.5, max: 8, unit: "m", group: "wall" },
        { id: "thickness", label: "Thickness", type: "number", default: 0.3, min: 0.18, max: 0.6, unit: "m", group: "wall" },
        { id: "block", label: "Block length", type: "number", default: 0.5, min: 0.3, max: 0.8, unit: "m", group: "wall", description: "Courses are half as tall." },
        { id: "openings", label: "Window openings", type: "int", default: 2, min: 0, max: "=max(0, floor(length / (openingWidth + 1.4)))", group: "wall" },
        { id: "openingWidth", label: "Opening width", type: "number", default: 1.3, min: 0.7, max: 2.4, unit: "m", group: "wall", visibleIf: "=openings > 0" },
        { id: "ruin", label: "Ruin", type: "number", default: 0.55, min: 0, max: 0.95, group: "damage", description: "How far the top has come down, and how ragged it is." },
        { id: "holes", label: "Shell holes", type: "number", default: 0.25, min: 0, max: 1, group: "damage" },
        { id: "rebar", label: "Rebar in the top", type: "bool", default: true, group: "damage" },
        { id: "rubble", label: "Rubble", type: "number", default: 0.6, min: 0, max: 1, group: "remains" },
        { id: "slab", label: "Floor slab stub", type: "bool", default: true, group: "remains", visibleIf: "=height > 3.6" },
        { id: "returnWall", label: "Return wall", type: "number", default: 3, min: 0, max: 6, unit: "m", group: "remains", description: "A stretch of wall turning back from the +X end (0 for none)." },
        { id: "wallFinish", label: "Wall", type: "material", default: "masonry.brick", materials: ["masonry", "stone"], group: "materials" },
        { id: "trimFinish", label: "Slab and lintels", type: "material", default: "masonry.darkConcrete", materials: ["masonry", "stone"], group: "materials" },
        { id: "rubbleFinish", label: "Rubble", type: "material", default: "ground.rubble", materials: ["ground", "masonry", "stone"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 11, group: "materials", variation: 0 },
    ],
    derived: {
        courseH: "=block / 2",
        cols: "=max(2, round(length / block))",
        courses: "=max(2, round(height / (block / 2)))",
        rcols: "=max(1, round(returnWall / block))",
        sillY: "=min(0.9, height * 0.25)",
        headY: "=min(0.9, height * 0.25) + min(1.5, height * 0.45)",
        slabY: "=min(3.2, height * 0.6)",
    },
    rules: [
        { check: "=openings == 0 || length / (openings + 1) > openingWidth + 0.4", message: "The openings overlap." },
    ],
    regions: {
        wall: { label: "Wall", material: "=wallFinish" },
        trim: { label: "Slab and lintels", material: "=trimFinish" },
        rubble: { label: "Rubble", material: "=rubbleFinish" },
        rebar: { label: "Rebar", material: "metal.rustDark" },
    },
    presets: [
        { name: "Bombed brick terrace", values: {} },
        { name: "Concrete block stump", values: { length: 6, height: 3, block: 0.4, ruin: 0.4, openings: 1, openingWidth: 1, slab: false, returnWall: 0, wallFinish: "masonry.darkConcrete", trimFinish: "masonry.concrete", seed: 4 } },
        { name: "Gutted facade", values: { length: 14, height: 7.5, ruin: 0.3, openings: 4, openingWidth: 1.4, holes: 0.4, returnWall: 4, wallFinish: "masonry.buff", seed: 8 } },
        { name: "Fieldstone remains", values: { length: 7, height: 2.6, block: 0.6, thickness: 0.5, ruin: 0.7, openings: 0, slab: false, rebar: false, returnWall: 2.5, wallFinish: "masonry.fieldstone", rubbleFinish: "stone.granite", seed: 15 } },
        { name: "Last corner standing", values: { length: 5, height: 7, ruin: 0.85, openings: 1, returnWall: 5, rubble: 1, seed: 21 } },
    ],
    nodes: [
        {
            id: "blocks", type: "mesh.box", repeat: "=cols * courses",
            keep: `=(${ROW} + 1) * courseH <= ${top(U)} + 0.001 && abs(${U}) <= length / 2 + 0.001 && !${inOpening(U, `${ROW} * courseH + courseH / 2`)} && !(rand(index, 9) < holes * 0.07 && (${ROW} + 3) * courseH < ${top(U)})`,
            size: ["=block - 0.012", "=courseH - 0.012", "=thickness"],
            at: [`=${U}`, `=${ROW} * courseH + courseH / 2`, 0], region: "wall",
        },
        // Lintels where the wall still stands over an opening.
        { id: "lintels", type: "mesh.box", repeat: "=openings", keep: `=${top(OU("index"))} > headY + 0.3`, size: ["=openingWidth + block", 0.2, "=thickness + 0.02"],
            at: [`=${OU("index")}`, "=headY + 0.1", 0], region: "trim" },
        { id: "sills", type: "mesh.box", repeat: "=openings", size: ["=openingWidth + 0.2", 0.08, "=thickness + 0.1"], at: [`=${OU("index")}`, "=sillY - 0.04", 0], region: "trim" },
        // Return wall at the +X end, running back toward -Z, more broken toward its end.
        {
            id: "returnBlocks", type: "mesh.box", when: "=returnWall > 0.2", repeat: "=rcols * courses",
            keep: `=(${RROW} + 1) * courseH <= ${top(`length / 2 - ${RU} * 0.8`)} * (1 - ${RU} / max(0.1, returnWall) * 0.45) + 0.001 && ${RU} <= returnWall + 0.001`,
            size: ["=thickness", "=courseH - 0.012", "=block - 0.012"],
            at: ["=length / 2 - thickness / 2", `=${RROW} * courseH + courseH / 2`, `=-thickness / 2 - ${RU}`], region: "wall",
        },
        // A floor slab stub hanging off the -Z face where the floor once was.
        { id: "slab", type: "mesh.box", when: `=slab && height > 3.6 && ${top("0")} > slabY + 0.4`, size: ["=length * 0.45", 0.22, 1.6], rotate: [-7, 0, 3],
            at: ["=length * 0.05", "=slabY - 0.28", "=-thickness / 2 - 0.75"], region: "trim" },
        { id: "slabRebar", type: "mesh.cylinder", when: `=slab && height > 3.6 && ${top("0")} > slabY + 0.4`, repeat: 7, radius: 0.012, height: "=0.4 + rand(index, 12) * 0.5", segments: 5,
            rotate: ["=-90 - 7 + (rand(index, 13) - 0.5) * 40", 0, "=(rand(index, 14) - 0.5) * 30"],
            at: ["=length * 0.05 + (index / 6 - 0.5) * length * 0.4", "=slabY - 0.28 + 1.55 * sin(rad(7))", "=-thickness / 2 - 1.5"], region: "rebar" },
        { id: "topRebar", type: "mesh.cylinder", when: "=rebar && ruin > 0.1", repeat: "=max(2, round(length / 1.4))", radius: 0.012, height: "=0.4 + rand(index, 15) * 0.7", segments: 5,
            rotate: ["=(rand(index, 16) - 0.5) * 50", 0, "=(rand(index, 17) - 0.5) * 50"],
            at: [`=(index + 0.5) * length / count - length / 2`, `=floor(${top("(index + 0.5) * length / count - length / 2")} / courseH) * courseH - 0.1`, 0], region: "rebar" },
        // Rubble: a low mound along each face and loose chunks.
        { id: "moundBase", type: "mesh.icosphere", output: false, radius: 1, subdivisions: 3 },
        { id: "mounds", type: "deform.noise", when: "=rubble > 0", repeat: 3, mesh: "@moundBase", amount: 0.25, frequency: 1.6, octaves: 3, seed: "=seed + index", radial: true,
            scale: ["=length * (0.18 + rand(index, 18) * 0.12) * (0.6 + rubble * 0.6)", "=0.6 * rubble + 0.15", "=0.9 + rubble * 0.6"],
            at: ["=(index - 1) * length * 0.32 + (rand(index, 19) - 0.5) * length * 0.1", -0.05, "=(index == 1 ? -1 : 1) * (thickness / 2 + 0.55)"], region: "rubble" },
        { id: "chunks", type: "mesh.box", when: "=rubble > 0", repeat: "=round(rubble * length * 4)", size: ["=block * (0.6 + rand(index, 20) * 0.8)", "=block * (0.3 + rand(index, 21) * 0.4)", "=block * (0.5 + rand(index, 22) * 0.6)"],
            rotate: ["=rand(index, 23) * 60 - 30", "=rand(index, 24) * 360", "=rand(index, 25) * 60 - 30"],
            at: ["=(rand(index, 26) - 0.5) * length * 1.05", "=block * 0.12", "=(rand(index, 27) < 0.5 ? -1 : 1) * (thickness / 2 + 0.2 + rand(index, 28) * 1.6)"],
            region: "=rand(index, 29) < 0.55 ? 'wall' : 'trim'" },
    ],
    limits: { maxSize: 20, minSize: 1.5, maxTriangles: 60000, floor: false },
};

export default ruinDef;
