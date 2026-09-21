/** MCP tool definitions for Canvas Surfaces: names, descriptions and JSON schemas only. The handlers
 * live in canvas_surface_addon.ts (they need its state); a test asserts every name here has exactly one
 * handler and every handler has a definition here. Descriptions are what an MCP client reads, so they say
 * what a call returns and which unit or convention applies. */
export interface ToolSchema { description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] }; }

const ref = (what: string) => ({ type: "string", description: `Id or exact name of ${what}.` });
const vec3 = (description: string) => ({ type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description });
const xz = (description: string) => ({ type: "array", items: { type: "number" }, minItems: 2, maxItems: 3, description });
const color = { type: ["array", "string"], items: { type: "number" }, description: 'Colour as [r, g, b] with each 0-255, or "#rrggbb".' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required });
const size = {
    type: "object", description: "World-unit sizes. plane: width, height. box: width, height, depth. cylinder: radius, height (axis is Y). sphere: radius.",
    properties: { width: { type: "number" }, height: { type: "number" }, depth: { type: "number" }, radius: { type: "number" } },
};
const action = {
    type: "object",
    description: 'One step of a rule. do "message" needs text (use {counter} to print a counter). "show", "hide" and "teleport" need target (a surface or group). "add" needs counter and optionally amount (default 1, may be negative). "clip" needs clip. "wait" needs seconds.',
    properties: {
        do: { type: "string", enum: ["message", "show", "hide", "teleport", "add", "clip", "wait"] },
        text: { type: "string" }, target: ref("a surface or group"), counter: { type: "string" }, amount: { type: "number" }, clip: ref("an animation clip"), seconds: { type: "number" },
    },
    required: ["do"],
};

export const CANVAS_TOOLS = {
    canvas_get_scene: {
        description: "Read the whole open scene: every surface (id, name, kind, position, rotation, size, parent, visible, solid), every group, animation clips, logic node counts, the world settings (player, walk bounds, lighting) and whether Play is running. Call this first in a session and after big edits. Positions of a surface with a parent are local to that parent group. Y is up, the ground is y = 0.",
        parameters: object({}),
    },
    canvas_world_stats: {
        description: "Budget check. Reports surface count against the 128 limit, estimated memory (each surface holds about 5 MB of pixels while open), estimated saved scene size against the 256 MiB limit (unpainted single-colour surfaces are saved as a colour, so only painted ones cost real space), and node/wire/group/clip counts against their limits. Call it before adding a lot more and before saving.",
        parameters: object({}),
    },
    canvas_new_scene: {
        description: "Discard the open scene and start an empty one (no surfaces, no groups, no logic, default lighting). If the open scene has unsaved changes this refuses unless confirmDiscard is true, so a person's unsaved painting is never lost by accident.",
        parameters: object({ name: { type: "string", description: "Scene name. Default \"Untitled scene\"." }, confirmDiscard: { type: "boolean" } }),
    },
    canvas_list_scenes: {
        description: "List the saved scenes in the scene library, each with its id and name. Use a name or id with canvas_load_scene.",
        parameters: object({}),
    },
    canvas_save_scene: {
        description: "Save the open scene to the library. Saves over the scene it was loaded from unless asNew is true. Returns the saved name and id.",
        parameters: object({ name: { type: "string", description: "Rename before saving." }, asNew: { type: "boolean", description: "Save a new library entry instead of overwriting." } }),
    },
    canvas_load_scene: {
        description: "Replace the open scene with a saved one. Refuses if the open scene has unsaved changes unless confirmDiscard is true.",
        parameters: object({ scene: ref("the saved scene (see canvas_list_scenes)"), confirmDiscard: { type: "boolean" } }, ["scene"]),
    },
    canvas_create_surface: {
        description: "Create one flat-coloured surface: a plane (faces +Z until rotated), box, cylinder (axis Y) or sphere. Give it a colour and the artist paints over it later. For a ground plane use kind plane with pitch -1.5708 so it faces up, or use canvas_add_prefab with prefab \"ground\". Returns the surface id and final name (names are made unique by adding a number).",
        parameters: object({
            name: { type: "string" }, kind: { type: "string", enum: ["plane", "box", "cylinder", "sphere"], description: "Default plane." },
            position: vec3("Centre of the surface, [x, y, z]. Local to the parent group if parent is set."), size,
            yaw: { type: "number", description: "Radians about Y." }, pitch: { type: "number", description: "Radians about X." }, roll: { type: "number", description: "Radians about Z." },
            color, parent: ref("a group to place this in"), solid: { type: "boolean", description: "Blocks the player in Play." }, visible: { type: "boolean" },
        }, ["position"]),
    },
    canvas_update_surface: {
        description: "Change an existing surface. Only the fields you pass change. Setting parent keeps the surface where it is in the world; pass null to detach it. Setting color repaints the whole surface, so it refuses if the surface has brush strokes unless overwrite is true. position, yaw, pitch and roll are then read relative to the new parent.",
        parameters: object({
            surface: ref("the surface"), name: { type: "string" }, position: vec3("[x, y, z]"), size,
            yaw: { type: "number" }, pitch: { type: "number" }, roll: { type: "number" }, bend: { type: "number", description: "-1 to 1, planes only." },
            color, overwrite: { type: "boolean", description: "Allow color to erase brush strokes." },
            visible: { type: "boolean" }, solid: { type: "boolean" }, parent: { type: ["string", "null"], description: "Group id or name, or null to detach." },
        }, ["surface"]),
    },
    canvas_fill_surface: {
        description: "Paint a surface one flat colour. Refuses on a surface with brush strokes unless overwrite is true. Undoable.",
        parameters: object({ surface: ref("the surface"), color, overwrite: { type: "boolean" } }, ["surface", "color"]),
    },
    canvas_delete: {
        description: "Delete a surface, or a group. Deleting a group ungroups its children unless deleteChildren is true, which deletes everything under it. Logic nodes that pointed at a deleted thing are kept but flagged (Play refuses until they are fixed); the reply counts them.",
        parameters: object({ ref: ref("a surface or group"), deleteChildren: { type: "boolean" } }, ["ref"]),
    },
    canvas_create_group: {
        description: "Create an empty group: a transform that moves, rotates and animates the surfaces placed under it. Use it for anything made of several parts, and for the player.",
        parameters: object({ name: { type: "string" }, position: vec3("[x, y, z] of the group origin."), yaw: { type: "number" }, parent: ref("a parent group") }, ["name"]),
    },
    canvas_update_group: {
        description: "Move, rotate, scale, rename or reparent a group. Only the fields you pass change. Moving a group moves everything under it.",
        parameters: object({
            group: ref("the group"), name: { type: "string" }, position: vec3("[x, y, z]"), yaw: { type: "number" }, pitch: { type: "number" }, roll: { type: "number" },
            scale: vec3("[sx, sy, sz], each above 0."), parent: { type: ["string", "null"], description: "Group id or name, or null." },
        }, ["group"]),
    },
    canvas_list_prefabs: {
        description: "List the ready-made props canvas_add_prefab can place (house, tree, human, pickup, chest, rock, fence, gate, lamppost, signpost, ground, pond), each with its parameters, defaults and how many surfaces it costs.",
        parameters: object({}),
    },
    canvas_add_prefab: {
        description: "Place a ready-made prop as one group of flat-coloured surfaces. Origin is on the ground, front faces +Z, yaw turns it. A house is 6 surfaces, a tree 2, a human 3. Returns the group id (use it as a logic target: a rule on a group covers every part) and each surface id. Colour parameters take [r,g,b] 0-255 or \"#rrggbb\".",
        parameters: object({
            prefab: { type: "string", enum: ["house", "tree", "human", "pickup", "chest", "rock", "fence", "gate", "lamppost", "signpost", "ground", "pond"] },
            name: { type: "string", description: "Group name. Default is the prefab name." },
            position: xz("[x, z] on the ground, or [x, y, z]."), yaw: { type: "number", description: "Radians about Y." },
            params: { type: "object", description: "Prefab parameters from canvas_list_prefabs, e.g. {\"width\": 5, \"roofColor\": \"#8a3b2f\"}." },
        }, ["prefab", "position"]),
    },
    canvas_create_clip: {
        description: "Create an empty animation clip. Add keyframes with canvas_set_keyframes, play it from logic with a {do: \"clip\"} action.",
        parameters: object({ name: { type: "string" }, duration: { type: "number", description: "Seconds, 0.1 to 3600." } }, ["name", "duration"]),
    },
    canvas_set_keyframes: {
        description: "Set the keyframes of one property of a surface or group in a clip, replacing that track. Channels: x, y, z (world units), pitch, yaw, roll (radians), sx, sy, sz (scale, above 0). Values are absolute, not offsets. Keys need distinct times inside the clip's duration. A clip only animates what it names, so a door swing needs only a yaw track.",
        parameters: object({
            clip: ref("the clip"), target: ref("a surface or group"), channel: { type: "string", enum: ["x", "y", "z", "pitch", "yaw", "roll", "sx", "sy", "sz"] },
            keys: { type: "array", items: { type: "object", properties: { time: { type: "number" }, value: { type: "number" } }, required: ["time", "value"] } },
        }, ["clip", "target", "channel", "keys"]),
    },
    canvas_delete_clip: {
        description: "Delete an animation clip. Logic nodes that played it are flagged.",
        parameters: object({ clip: ref("the clip") }, ["clip"]),
    },
    canvas_get_logic: {
        description: "Read the gameplay logic graph: each node (id, kind, target name, text, seconds, counter, amount), each wire, and any problems that would stop Play (a node with no target, a loop). Node kinds: start, click, near, interact (events); once, wait, message, show, hide, add, check, clip, teleport (actions).",
        parameters: object({}),
    },
    canvas_add_rule: {
        description: "Add one 'when X, do Y' rule to the logic graph without placing nodes by hand. when.type: start (Play begins), click (a surface or group is clicked), near (the player walks within distance of a target, fires once each time they enter), interact (the player presses E within distance; prompt is the on-screen hint). conditions each need counter plus atLeast or below, and all must hold for then. once runs then only the first time per Play. otherwise runs when the single condition does not hold. Counters start at 0 each Play; messages can print one with {counter}. Returns how many nodes were added.",
        parameters: object({
            when: {
                type: "object",
                properties: { type: { type: "string", enum: ["start", "click", "near", "interact"] }, target: ref("a surface or group"), distance: { type: "number", description: "Metres. Default 1.5." }, prompt: { type: "string" } },
                required: ["type"],
            },
            once: { type: "boolean" },
            conditions: { type: "array", items: { type: "object", properties: { counter: { type: "string" }, atLeast: { type: "number" }, below: { type: "number" } }, required: ["counter"] } },
            then: { type: "array", items: action }, otherwise: { type: "array", items: action },
        }, ["when", "then"]),
    },
    canvas_add_collectible: {
        description: "Shortcut for a pickup: when the player walks near target it disappears (once), the counter goes up and a message shows. The target is usually a pickup prefab's group id.",
        parameters: object({
            target: ref("the pickup (a surface or group)"), counter: { type: "string", description: "Counter name, e.g. \"herbs\"." }, amount: { type: "number", description: "Default 1." },
            message: { type: "string", description: "Default \"Collected: <counter> {<counter>}\"." }, distance: { type: "number", description: "Default 1.2." },
        }, ["target", "counter"]),
    },
    canvas_set_logic: {
        description: "Replace (or with append true, extend) the whole logic graph. Prefer canvas_add_rule; use this for shapes a rule cannot express. Each node: kind, optional id (a local handle for connections), target (surface, group or clip name or id), text, seconds (0.05 to 60), variable and amount (counters), op (\">=\" or \"<\" for check), distance for near and interact. connections are {from, to} pairs of node ids; events cannot be a destination and loops are rejected. Nodes without a position are laid out in a grid.",
        parameters: object({
            nodes: { type: "array", items: { type: "object", properties: {
                id: { type: "string" }, kind: { type: "string", enum: ["start", "click", "near", "interact", "once", "clip", "wait", "message", "show", "hide", "add", "check", "teleport"] },
                target: { type: "string" }, text: { type: "string" }, seconds: { type: "number" }, variable: { type: "string" }, amount: { type: "number" }, op: { type: "string", enum: [">=", "<"] },
                distance: { type: "number" }, position: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
            }, required: ["kind"] } },
            connections: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
            append: { type: "boolean" },
        }, ["nodes"]),
    },
    canvas_clear_logic: {
        description: "Remove every node and wire from the gameplay logic graph, leaving the scene otherwise untouched. Undoable with canvas_undo.",
        parameters: object({}),
    },
    canvas_set_world: {
        description: "Set the player and the walking area. player is a root group (for example a human prefab's group) or a root surface; the keyboard moves it in Play (WASD, camera-relative) and the camera follows. Pass null for no player, which leaves Play as click-only with the orbit camera. bounds is how far from the origin the player may walk.",
        parameters: object({ player: { type: ["string", "null"], description: "Group or surface id or name, or null." }, bounds: { type: "number", description: "1 to 1000. Default 40." } }),
    },
    canvas_set_lighting: {
        description: "Set the scene lighting and sky. Start from a preset (editor, day, golden_hour, dusk, night, overcast) and override any field. sunDirection points toward the sun. ambient, skyFill, groundFill and sunColor are [r, g, b] (0-1 typical); fillStrength scales the sky/ground tint by surface direction; fogDensity fades distant surfaces into fogColor (0.01 is gentle, 0.03 thick). lamps (at most 4) are point lights {position, color, intensity, reach}, where reach scales how far they carry (1 is the editor default, 4 lights a village square). horizonColor and zenithColor paint the sky. Lighting is saved with the scene. Returns the resulting settings.",
        parameters: object({
            preset: { type: "string", enum: ["editor", "day", "golden_hour", "dusk", "night", "overcast"] },
            ambient: vec3("[r, g, b]"), sunDirection: vec3("[x, y, z] toward the sun."), sunColor: vec3("[r, g, b]"), sunIntensity: { type: "number", description: "0 to 10." },
            skyFill: vec3("[r, g, b]"), groundFill: vec3("[r, g, b]"), fillStrength: { type: "number", description: "0 to 4." },
            fogColor: vec3("[r, g, b] each 0-1."), fogDensity: { type: "number", description: "0 to 0.5." }, horizonColor: vec3("[r, g, b] each 0-1."), zenithColor: vec3("[r, g, b] each 0-1."),
            lamps: { type: "array", items: { type: "object", properties: { position: vec3("[x, y, z]"), color: vec3("[r, g, b]"), intensity: { type: "number" }, reach: { type: "number" } }, required: ["position"] } },
        }),
    },
    canvas_set_camera: {
        description: "Move the editing camera. Give position and target, or focus on a surface or group. Not available during Play (the camera follows the player).",
        parameters: object({ position: vec3("Camera position."), target: vec3("Point to look at."), focus: ref("a surface or group to frame"), distance: { type: "number", description: "Distance from the focus. Default fits it." } }),
    },
    canvas_play: {
        description: "Press Play in the editor window so a person can watch. Fails with the reason if the logic has a problem (a node with no target). With a player set, WASD walks and E interacts; Stop restores everything. To verify the game without watching, use canvas_playtest instead.",
        parameters: object({}),
    },
    canvas_stop: {
        description: "Stop Play and return to editing. The scene, poses and visibility are restored exactly. Safe to call when Play is not running.",
        parameters: object({}),
    },
    canvas_get_play_state: {
        description: "While Play is running: the message on screen, every counter, the interaction prompt, the player's [x, z], and which surfaces the game has hidden. playing is false otherwise.",
        parameters: object({}),
    },
    canvas_playtest: {
        description: "Play the game headlessly inside one call and report what happened, then restore the scene untouched. Nothing is drawn or moved on screen. It runs the same logic, collision and triggers as real Play. steps run in order; each has exactly one key: walkTo ([x, z] or a surface/group; optional within, default 1), interact (true), click (a surface/group), wait (seconds), expect ({counters: {name: value}, message: substring, shown: {surface: true|false}, near: {target, within}}). Reports every message shown, the counters, the final position and each failed expectation, so a whole quest can be checked in one call. walkTo fails with what blocked it if the straight path hits a solid surface: route around with several walkTo steps.",
        parameters: object({
            steps: { type: "array", items: { type: "object", properties: {
                walkTo: { type: ["array", "string"], items: { type: "number" }, description: "[x, z] or a surface/group id or name." }, within: { type: "number" },
                interact: { type: "boolean" }, click: ref("a surface or group"), wait: { type: "number" },
                expect: { type: "object", properties: { counters: { type: "object" }, message: { type: "string" }, shown: { type: "object" }, near: { type: "object" } } },
            } } },
        }, ["steps"]),
    },
    canvas_undo: {
        description: "Undo the last edit or edits (each tool call that changes the scene is one undo step, batched per frame). Returns the label of what was undone.",
        parameters: object({ steps: { type: "number", description: "Default 1." } }),
    },
    canvas_redo: {
        description: "Redo the edit that canvas_undo just undid. Returns the label of what was redone, or null when there is nothing to redo.",
        parameters: object({}),
    },
} satisfies Record<string, ToolSchema>;
export type CanvasToolName = keyof typeof CANVAS_TOOLS;
export const CANVAS_TOOL_NAMES = Object.keys(CANVAS_TOOLS) as CanvasToolName[];
