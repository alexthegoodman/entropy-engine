import type { ObjectDef } from "../mesha_object";

// An ISO shipping container, doors at the +Z end, length along Z. Hollow: floor, roof, side walls
// built of panels (so a scavenger's cut doorway is a real opening into the box), a corrugated front
// end, a frame of corner posts and rails with castings, and two door leaves that swing out about
// their hinges. Stack piles more on top, each copy offset and turned a little; Roll tips the whole
// pile over onto its side.

export const containerDef: ObjectDef = {
    id: "transport.container",
    name: "Shipping Container",
    category: "Transport",
    tags: ["shipping container", "container", "cargo", "intermodal", "box", "storage", "rust", "rusted", "corrugated", "port", "industrial", "barricade", "shelter", "post-apocalyptic", "wasteland"],
    description: "A rusting 20 or 40 ft shipping container: hollow, with swinging doors, a cut-in doorway, dents of missing panels, and stacking or tipping over.",
    featured: ["size", "doorsOpen", "cutDoor", "stack", "roll", "shellFinish"],
    groups: [
        { id: "box", label: "Container" },
        { id: "wreck", label: "Wear" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "size", label: "Size", type: "enum", default: "20", options: ["20", "40"], optionLabels: ["20 ft", "40 ft"], group: "box" },
        { id: "highCube", label: "High cube", type: "bool", default: false, group: "box" },
        { id: "doorsOpen", label: "Doors open", type: "number", default: 0.3, min: 0, max: 1, group: "box", description: "0 shut, 1 swung right round against the sides." },
        { id: "cutDoor", label: "Cut doorway", type: "bool", default: false, group: "box", description: "A panel cut out of the +X side." },
        { id: "stack", label: "Stacked", type: "int", default: 1, min: 1, max: 3, group: "box" },
        { id: "roll", label: "Tipped", type: "number", default: 0, min: 0, max: 90, unit: "deg", group: "wreck", description: "Rolls the pile onto its +X side." },
        { id: "missingPanels", label: "Missing panels", type: "number", default: 0.08, min: 0, max: 0.5, group: "wreck" },
        { id: "shellFinish", label: "Walls", type: "material", default: "metal.corrugatedRust", materials: ["metal.corrugated", "metal.corrugatedRust", "metal.corrugatedRed", "metal.corrugatedGreen"], group: "materials" },
        { id: "frameFinish", label: "Frame", type: "material", default: "metal.rustDark", materials: ["metal.rust", "metal.rustRed", "metal.rustDark", "metal.black", "paint.black"], group: "materials" },
        { id: "doorFinish", label: "Doors", type: "material", default: "metal.corrugatedRed", materials: ["metal.corrugated", "metal.corrugatedRust", "metal.corrugatedRed", "metal.corrugatedGreen"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 7, group: "materials", variation: 0 },
    ],
    derived: {
        L: "=size == '40' ? 12.19 : 6.06", W: 2.44, H: "=highCube ? 2.9 : 2.59",
        panels: "=size == '40' ? 10 : 5",
        pw: "=(size == '40' ? 12.19 : 6.06) / (size == '40' ? 10 : 5)",
        doorA: "=doorsOpen * 260",
    },
    regions: {
        shell: { label: "Walls", material: "=shellFinish" },
        frame: { label: "Frame", material: "=frameFinish" },
        doors: { label: "Doors", material: "=doorFinish" },
        floor: { label: "Floor", material: "wood.weathered" },
        dark: { label: "Inside", material: "metal.black" },
    },
    presets: [
        { name: "Rusted 20 ft", values: {} },
        { name: "Scavenger shelter", values: { size: "20", doorsOpen: 0.55, cutDoor: true, missingPanels: 0.05, shellFinish: "metal.corrugatedGreen", doorFinish: "metal.corrugatedRust", seed: 3 } },
        { name: "Stacked 40 ft", values: { size: "40", stack: 2, doorsOpen: 0, missingPanels: 0.04, shellFinish: "metal.corrugatedRed", doorFinish: "metal.corrugatedRed", seed: 5 } },
        { name: "Tipped wreck", values: { roll: 90, doorsOpen: 0.15, missingPanels: 0.2, seed: 9 } },
        { name: "Port blue high cube", values: { size: "40", highCube: true, doorsOpen: 1, missingPanels: 0, shellFinish: "metal.corrugated", doorFinish: "metal.corrugated", frameFinish: "paint.black", seed: 1 } },
    ],
    nodes: [
        // One container, standing on its origin.
        { id: "floorPlate", type: "mesh.box", output: false, size: ["=W - 0.1", 0.16, "=L - 0.1"], at: [0, 0.14, 0], region: "floor" },
        { id: "roof", type: "mesh.box", output: false, size: ["=W - 0.06", 0.05, "=L - 0.08"], at: [0, "=H - 0.06", 0], region: "shell" },
        { id: "sides", type: "mesh.box", output: false, repeat: "=panels * 2", size: [0.04, "=H - 0.24", "=pw - 0.01"],
            keep: "=!(cutDoor && index % 2 == 0 && floor(index / 2) == floor(panels / 2)) && rand(index, 3) >= missingPanels",
            at: ["=(index % 2 == 0 ? 1 : -1) * (W / 2 - 0.04)", "=H / 2", "=-L / 2 + (floor(index / 2) + 0.5) * pw"], region: "shell" },
        { id: "front", type: "mesh.box", output: false, size: ["=W - 0.1", "=H - 0.24", 0.04], at: [0, "=H / 2", "=-L / 2 + 0.04"], region: "shell" },
        { id: "inside", type: "mesh.box", output: false, size: ["=W - 0.2", 0.01, "=L - 0.3"], at: [0, "=H - 0.09", 0], region: "dark" },
        // Frame: corner posts, top and bottom rails, castings.
        { id: "posts", type: "mesh.box", output: false, repeat: 4, size: [0.14, "=H", 0.14], at: ["=(index % 2 == 0 ? 1 : -1) * (W / 2 - 0.07)", "=H / 2", "=(index < 2 ? 1 : -1) * (L / 2 - 0.07)"], region: "frame" },
        { id: "railsLong", type: "mesh.box", output: false, repeat: 4, size: [0.12, 0.14, "=L - 0.2"], at: ["=(index % 2 == 0 ? 1 : -1) * (W / 2 - 0.06)", "=index < 2 ? 0.07 : H - 0.07", 0], region: "frame" },
        { id: "railsEnd", type: "mesh.box", output: false, repeat: 4, size: ["=W - 0.2", 0.16, 0.12], at: [0, "=index % 2 == 0 ? 0.08 : H - 0.08", "=(index < 2 ? 1 : -1) * (L / 2 - 0.06)"], region: "frame" },
        { id: "castings", type: "mesh.box", output: false, repeat: 8, size: [0.18, 0.12, 0.18],
            at: ["=(index % 2 == 0 ? 1 : -1) * (W / 2 - 0.08)", "=floor(index / 4) == 0 ? 0.06 : H - 0.06", "=(floor(index / 2) % 2 == 0 ? 1 : -1) * (L / 2 - 0.08)"], region: "frame" },
        // Door leaves, hinged on the corner posts, each with a locking bar.
        { id: "leaves", type: "mesh.box", output: false, repeat: 2, size: ["=W / 2 - 0.08", "=H - 0.26", 0.05],
            rotate: [0, "=(index == 0 ? 1 : -1) * doorA * (0.85 + rand(index, 4) * 0.15)", 0],
            at: [
                "=(index == 0 ? 1 : -1) * (W / 2 - 0.07 - (W / 4 - 0.04) * cos(rad(doorA * (0.85 + rand(index, 4) * 0.15))))",
                "=H / 2",
                "=L / 2 - 0.02 + (W / 4 - 0.04) * sin(rad(doorA * (0.85 + rand(index, 4) * 0.15)))",
            ], region: "doors" },
        { id: "bars", type: "mesh.cylinder", output: false, repeat: 2, radius: 0.025, height: "=H - 0.3", segments: 6,
            at: [
                "=(index == 0 ? 1 : -1) * (W / 2 - 0.07 - (W / 4 - 0.04) * cos(rad(doorA * (0.85 + rand(index, 4) * 0.15))))",
                0.15,
                "=L / 2 - 0.02 + (W / 4 - 0.04) * sin(rad(doorA * (0.85 + rand(index, 4) * 0.15))) + 0.05 * cos(rad(doorA * (0.85 + rand(index, 4) * 0.15)))",
            ], region: "frame" },
        { id: "unit", type: "geo.join", output: false, meshes: ["@floorPlate", "@roof", "@sides", "@front", "@inside", "@posts", "@railsLong", "@railsEnd", "@castings", "@leaves", "@bars"] },
        { id: "pile", type: "geo.transform", output: false, repeat: "=stack", mesh: "@unit",
            rotate: [0, "=index == 0 ? 0 : (rand(index, 5) - 0.5) * 14", 0], at: ["=index == 0 ? 0 : (rand(index, 6) - 0.5) * 0.4", "=index * H", "=index == 0 ? 0 : (rand(index, 7) - 0.5) * 0.8"] },
        // Tipping rolls the pile about its +X bottom edge, onto its side.
        { id: "tipped", type: "geo.transform", mesh: "@pile", rotate: [0, 0, "=-roll"], at: ["=W / 2 * (1 - cos(rad(roll)))", "=W / 2 * sin(rad(roll))", 0] },
    ],
    limits: { maxSize: 14, minSize: 2, maxTriangles: 20000 },
};

export default containerDef;
