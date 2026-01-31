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
                            heights: config.heights || null,
                            noiseId: config.noiseId || null,
                            position: config.position || [0, 0, 0],
                            pipelineId: config.pipelineId || null
                        });
                    }
                },
                Particles: {
                    createHair: (config) => {
                        ops.op_grass_create(metadata.name, {
                            id: config.id || null,
                            gridSize: config.gridSize || 2.0,
                            renderDistance: config.renderDistance || 150.0,
                            windStrength: config.windStrength || 2.5,
                            windSpeed: config.windSpeed || 0.3,
                            bladeHeight: config.bladeHeight || 2.75,
                            bladeWidth: config.bladeWidth || 0.03,
                            brownianStrength: config.brownianStrength || 0.03,
                            bladeDensity: config.bladeDensity || 15.0,
                            landscapeSize: config.landscapeSize || 4096.0,
                            landscapeHeight: config.landscapeHeight || 0.0,
                            landscapeYOffset: config.landscapeYOffset || 0.0,
                            pipelineId: config.pipelineId || null
                        });
                    }
                },
                Noise: {
                    create: (config) => {
                        return ops.op_noise_create({
                            noiseType: config.type || "fbm",
                            source: config.source || "perlin",
                            seed: config.seed || 0,
                            octaves: config.octaves || 6,
                            frequency: config.frequency || 0.01,
                            persistence: config.persistence || 0.5,
                            lacunarity: config.lacunarity || 2.0
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
        createWindow: (config) => {
            const windowId = ops.op_ui_create_window(config, config.onRender);
            return windowId;
        },
        createTab: (config) => {
            const tabId = ops.op_ui_create_tab(config, config.onRender);
            return tabId;
        },
        Widget: {
            label: (windowId, config) => {
                const text = typeof config === 'string' ? config : (config?.text || "");
                const bold = typeof config === 'object' ? (config?.bold || false) : false;
                ops.op_ui_widget_label(windowId, text, bold);
            },
            button: (windowId, config) => {
                const text = typeof config === 'string' ? config : (config?.text || "");
                const id = Math.random().toString(36).substring(2, 15);
                ops.op_ui_widget_button(windowId, text, id);
                
                // Add to event listeners
                if (typeof config === 'object' && config?.onClick) {
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
        create: (config) => {
            return ops.op_pipeline_create(config);
        }
    },
    Landscape: {
        create: (config) => {
            return ops.op_landscape_create("Global", {
                width: config.width,
                height: config.height,
                heights: config.heights || null,
                noiseId: config.noiseId || null,
                position: config.position || [0, 0, 0],
                pipelineId: config.pipelineId || null
            });
        }
    },
    Particles: {
        createHair: (config) => {
            return ops.op_grass_create("Global", {
                id: config.id || null,
                gridSize: config.gridSize || 2.0,
                renderDistance: config.renderDistance || 150.0,
                windStrength: config.windStrength || 2.5,
                windSpeed: config.windSpeed || 0.3,
                bladeHeight: config.bladeHeight || 2.75,
                bladeWidth: config.bladeWidth || 0.03,
                brownianStrength: config.brownianStrength || 0.03,
                bladeDensity: config.bladeDensity || 15.0,
                landscapeSize: config.landscapeSize || 4096.0,
                landscapeHeight: config.landscapeHeight || 0.0,
                landscapeYOffset: config.landscapeYOffset || 0.0,
                pipelineId: config.pipelineId || null
            });
        }
    },
    Noise: {
        create: (config) => {
            return ops.op_noise_create({
                noiseType: config.type || "fbm",
                source: config.source || "perlin",
                seed: config.seed || 0,
                octaves: config.octaves || 6,
                frequency: config.frequency || 0.01,
                persistence: config.persistence || 0.5,
                lacunarity: config.lacunarity || 2.0
            });
        }
    },
    println: (msg) => {
        ops.op_println(String(msg));
    }
};

// Convenience global
globalThis.println = globalThis.Entropy.println;

export {};
