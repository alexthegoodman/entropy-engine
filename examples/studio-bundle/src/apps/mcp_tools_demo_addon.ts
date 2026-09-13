// MCP Tools Demo Addon
//
// Registers a handful of small tools purely to prove out the MCP bridge in
// src/mcp/mod.rs: every registerTool() call here lands in AddonContext's tool
// registry (src/deno/addon_ops.rs) and is exposed automatically over MCP
// Streamable HTTP the moment this app runs - no addon-side wiring beyond
// registerTool itself. Point an MCP client at http://127.0.0.1:47100/mcp and
// these four tools are what it will see.

// Registered as "Global" deliberately, not a descriptive name: render_addon_frame.rs's
// per-content-type workspace filter (see e.g. its addon_meshes loop) only draws a
// non-"Global" addon's meshes/models when Studio's sidebar has that addon's tab
// selected (Workspace::Addon(name), set only by a UI click in src/core/render_egui.rs).
// A bare, Studio-less bin like this one starts and stays in Workspace::GameEngine, so
// there's no click that will ever happen - "Global" is the one name that bypasses the
// filter unconditionally, and it's the correct choice for a standalone app with no
// per-addon workspace concept in the first place.
const addon = Entropy.Addon.register({
    name: "Global",
    version: "1.0.0",
    description: "Spawn/list/remove cubes via MCP tool calls, to demo the Entropy MCP bridge",
    author: ["Entropy Team"],
    capabilities: {}
});

interface SpawnedObject {
    id: string;
    position: [number, number, number];
    color: [number, number, number];
}

const spawned: SpawnedObject[] = [];

// Cube.rs's own default geometry (position 0..1 per axis, one Vertex per corner,
// reused across faces via the index buffer) - kept identical so a spawned cube
// looks like every other cube in the engine. Color is overwritten per spawn.
const CUBE_CORNERS: [number, number, number][] = [
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], // front
    [0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], // back
];
const CUBE_NORMALS: [number, number, number][] = [
    [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1],
    [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1],
];
const CUBE_UVS: [number, number][] = [
    [0, 0], [1, 0], [1, 1], [0, 1],
    [1, 0], [1, 1], [0, 1], [0, 0],
];
const CUBE_INDICES = [
    0, 1, 2, 2, 3, 0, // front
    4, 5, 6, 6, 7, 4, // back
    3, 2, 6, 6, 5, 3, // top
    0, 4, 7, 7, 1, 0, // bottom
    1, 7, 6, 6, 2, 1, // right
    0, 3, 5, 5, 4, 0, // left
];

function buildCubeGeometry(scale: number, color: [number, number, number]) {
    const vertexData: number[] = [];
    for (let i = 0; i < CUBE_CORNERS.length; i++) {
        const [x, y, z] = CUBE_CORNERS[i];
        vertexData.push(
            x * scale, y * scale, z * scale,
            ...CUBE_NORMALS[i],
            ...CUBE_UVS[i],
            color[0], color[1], color[2], 1.0
        );
    }
    return { vertexData, indexData: CUBE_INDICES };
}

addon.onInit(() => {
    // Bare EntropyApp has no default camera framing or lighting - without these,
    // spawned cubes render but sit in the dark outside (or behind) the default view.
    Entropy.Camera.setTransform([0, 4, 9], [0, 0.5, 0]);
    Entropy.Lighting.createPointLight({
        id: "mcp-demo-key-light",
        position: [0, 6, 6],
        color: [1, 1, 1],
        intensity: 3,
        maxDistance: 40
    });

    Entropy.println("MCP Tools Demo ready - call spawn_shape / list_scene_objects / remove_shape / clear_scene over MCP");
});

addon.registerTool({
    name: "spawn_shape",
    description: "Spawn a cube in the scene at a given position, with an optional color and scale. Returns the new object's id.",
    parameters: {
        type: "object",
        properties: {
            position: { type: "array", items: { type: "number" }, description: "[x, y, z] world position" },
            color: { type: "array", items: { type: "number" }, description: "[r, g, b], each 0-1. Defaults to white." },
            scale: { type: "number", description: "Uniform edge length. Defaults to 1." }
        },
        required: ["position"]
    }
}, (args: any) => {
    const id = Entropy.generateUUID();
    const position: [number, number, number] = args.position;
    const color: [number, number, number] = args.color ?? [1, 1, 1];
    const scale: number = args.scale ?? 1;

    const { vertexData, indexData } = buildCubeGeometry(scale, color);
    addon.Model.createMesh({
        id,
        position,
        vertexData,
        indexData,
        pipelineId: "default"
    });

    spawned.push({ id, position, color });
    return { success: true, id, position, color };
});

addon.registerTool({
    name: "list_scene_objects",
    description: "List every object this addon has spawned in the current session.",
    parameters: { type: "object", properties: {} }
}, () => {
    return { success: true, objects: spawned };
});

addon.registerTool({
    name: "remove_shape",
    description: "Remove a previously spawned object by id.",
    parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
    }
}, (args: any) => {
    const index = spawned.findIndex(o => o.id === args.id);
    if (index === -1) {
        return { success: false, error: `No spawned object with id ${args.id}` };
    }
    addon.Model.clearMesh(args.id);
    spawned.splice(index, 1);
    return { success: true };
});

addon.registerTool({
    name: "clear_scene",
    description: "Remove every object this addon has spawned.",
    parameters: { type: "object", properties: {} }
}, () => {
    const count = spawned.length;
    for (const obj of spawned) {
        addon.Model.clearMesh(obj.id);
    }
    spawned.length = 0;
    return { success: true, removed: count };
});
