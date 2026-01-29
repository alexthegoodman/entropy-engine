const { ops } = Deno.core;

globalThis.Entropy = {
    Addon: {
        register: async (metadata) => {
            return ops.op_addon_register(metadata);
        },
        onInit: (callback) => {
            // TODO: implement lifecycle hooks
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
    println: (msg) => {
        ops.op_println(String(msg));
    }
};

// Convenience global
globalThis.println = globalThis.Entropy.println;

export {};
