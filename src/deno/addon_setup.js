const { ops } = Deno.core;

globalThis.Entropy = {
    Addon: {
        register: async (metadata) => {
            await ops.op_addon_register(metadata);
            
            // Return scoped API
            return {
                Model: {
                    createProcedural: (config) => {
                        if (config.type === "cube") {
                            ops.op_cube_spawn(metadata.name, {
                                position: config.parameters?.position || [0, 0, 0],
                                scale: config.parameters?.scale || [1, 1, 1],
                                pipeline_id: config.pipelineId || null
                            });
                        }
                    }
                },
                Landscape: {
                    create: (config) => {
                        ops.op_landscape_create(metadata.name, {
                            width: config.width,
                            height: config.height,
                            heights: config.heights,
                            position: config.position || [0, 0, 0]
                        });
                    }
                }
            };
        },
        onInit: (callback) => {
            ops.op_addon_on_init(callback);
        },
        onCleanup: (callback) => {
            // TODO: implement lifecycle hooks
        }
    },
    UI: {
        createWindow: async (config) => {
            const windowId = ops.op_ui_create_window(config, config.onRender);
            return windowId;
        },
        createTab: async (config) => {
            const tabId = ops.op_ui_create_tab(config, config.onRender);
            return tabId;
        },
        Widget: {
            label: async (windowId, config) => {
                ops.op_ui_widget_label(windowId, config.text, config.bold || false);
            },
            button: async (windowId, config) => {
                const id = crypto.randomUUID();
                ops.op_ui_widget_button(windowId, config.text, id);
                
                // Add to event listeners
                if (config.onClick) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onClick;
                }
            }
        }
    },
    _process_events: (eventIds) => {
        for (const id of eventIds) {
            if (globalThis._entropy_event_listeners && globalThis._entropy_event_listeners[id]) {
                globalThis._entropy_event_listeners[id]();
            }
        }
    },
    Pipeline: {
        create: async (config) => {
            return ops.op_pipeline_create(config);
        }
    },
    Model: {
        createProcedural: async (config) => {
            // Global/unscoped version - uses "Global" as addon name
            if (config.type === "cube") {
                return ops.op_cube_spawn("Global", {
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
