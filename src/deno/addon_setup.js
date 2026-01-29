const { ops } = Deno.core;

globalThis.Entropy = {
    Addon: {
        register: async (metadata) => {
            return ops.op_addon_register(metadata);
        },
        onInit: (callback) => {
            ops.op_addon_on_init(callback);
        },
        onCleanup: (callback) => {
            // TODO: implement lifecycle hooks
        }
    },
    Pipeline: {
        create: async (config) => {
            return ops.op_pipeline_create(config);
        }
    },
    Model: {
        createProcedural: async (config) => {
            if (config.type === "cube") {
                return ops.op_cube_spawn({
                    position: config.parameters?.position || [0, 0, 0],
                    scale: config.parameters?.scale || [1, 1, 1]
                });
            }
        }
    },
    println: (msg) => {
        ops.op_println(String(msg));
    }
};

// Convenience global
globalThis.println = globalThis.Entropy.println;

export {};
