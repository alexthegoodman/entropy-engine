const { ops } = Deno.core;

globalThis.vec3 = (x, y, z) => ({ x, y, z });
globalThis.vec4 = (x, y, z, w) => ({ x, y, z, w });

globalThis._createSystem = () => {
    return {
        spawn_particles: (pos, color, grav) => {
            ops.op_system_spawn_particles(pos, color, grav);
        },
        vec3: (x, y, z) => ({ x, y, z }),
        log_particles: (pos, color, grav) => { 
             // no-op
        },
        debug_name: (val) => "System"
    };
};

globalThis._createDialogue = () => {
    return {
        show: (text) => ops.op_dialogue_show(text),
        add_option: (text, next_node) => ops.op_dialogue_add_option(text, next_node),
        start_quest: (id) => ops.op_dialogue_start_quest(id),
        close: () => ops.op_dialogue_close(),
        get_node: () => ops.op_dialogue_get_node(),
    };
};

globalThis.println = (msg) => ops.op_println(String(msg));

// Add this export to satisfy V8
export {};
