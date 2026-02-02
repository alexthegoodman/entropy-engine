const { ops } = Deno.core;

globalThis.Entropy = {
    Addon: {
        register: (metadata) => {
            ops.op_addon_register(metadata);
            
            // Return scoped API
            return {
                onInit: (callback) => {
                    ops.op_addon_on_init(metadata.name, callback);
                },
                onCleanup: (callback) => {
                    ops.op_addon_on_cleanup(metadata.name, callback);
                },
                onProjectChanged: (callback) => {
                    ops.op_addon_on_project_changed(metadata.name, callback);
                },
                UI: {
                    createTab: (config) => {
                        const tabId = ops.op_ui_create_tab(metadata.name, config, config.onRender);
                        return tabId;
                    },
                },
                Model: {
                    createProcedural: (config) => {
                        if (config.type === "cube") {
                            ops.op_cube_spawn(metadata.name, {
                                position: config.parameters?.position || [0, 0, 0],
                                scale: config.parameters?.scale || [1, 1, 1],
                                pipeline_id: config.pipelineId || null
                            });
                        }
                    },
                    createMesh: (config) => {
                        ops.op_mesh_create(metadata.name, {
                            position: config.position || [0, 0, 0],
                            vertexData: config.vertexData || [],
                            indexData: config.indexData || [],
                            pipelineId: config.pipelineId,
                            instanceCount: config.instanceCount || 1,
                            bindings: config.bindings || []
                        });
                    },
                    clearMeshes: () => {
                        ops.op_meshes_clear(metadata.name);
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
                        let merged_config = {
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
                            baseColor: config.baseColor || [0.1, 0.4, 0.1, 1.0],
                            tipColor: config.tipColor || [0.4, 0.8, 0.2, 1.0],
                            pipelineId: config.pipelineId || null,
                            bindings: config.bindings || []
                        };
                        ops.op_println(String("CreateOrUpdate Hair (2): " + metadata.name + " " + JSON.stringify(merged_config.baseColor)+ " " + JSON.stringify(merged_config.tipColor)));
                        ops.op_grass_create(metadata.name, merged_config);
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
                Lighting: {
                    createPointLight: (config) => {
                        ops.op_point_light_create(metadata.name, {
                            position: config.position || [0, 0, 0],
                            color: config.color || [1, 1, 1],
                            intensity: config.intensity || 1.0,
                            maxDistance: config.maxDistance || 20.0
                        });
                    },
                    updateSun: (config) => {
                        ops.op_lighting_update_sun({
                            horizonColor: config.horizonColor || [0.7, 0.8, 1.0],
                            zenithColor: config.zenithColor || [0.2, 0.3, 0.6],
                            sunDirection: config.sunDirection || [0.0, 1.0, 0.0],
                            sunColor: config.sunColor || [1.0, 0.9, 0.7],
                            sunIntensity: config.sunIntensity || 5.0
                        });
                    }
                },
                Audio: {
                    playSynth: (config) => {
                        ops.op_audio_play_synth({
                            freq: config.freq || 440.0,
                            waveform: config.waveform || "sine",
                            duration: config.duration || 0.5,
                            cutoff: config.cutoff || 20000.0,
                            gain: config.gain || 0.2
                        });
                    },
                    playTestTone: () => {
                        ops.op_audio_play_test();
                    }
                },
                IO: {
                    save: (data) => {
                        ops.op_addon_save_data(metadata.name, JSON.stringify(data));
                    },
                    load: () => {
                        const json = ops.op_addon_load_data(metadata.name);
                        if (!json || json === "") return null;
                        try {
                            return JSON.parse(json);
                        } catch (e) {
                            ops.op_println("Error parsing saved data: " + e);
                            return null;
                        }
                    }
                }
            };
        }
    },
    UI: {
        createWindow: (config) => {
            const windowId = ops.op_ui_create_window(config, config.onRender);
            return windowId;
        },
        createTab: (config) => {
            const tabId = ops.op_ui_create_tab("Global", config, config.onRender);
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
            },
            colorInput: (windowId, config) => {
                const label = config?.label || "";
                const color = config?.color || [1, 1, 1, 1];
                const id = Math.random().toString(36).substring(2, 15);
                ops.op_ui_widget_color_input(windowId, label, color, id);

                if (config?.onChange) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onChange;
                }
            },
            slider: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || 0;
                const min = config?.min || 0;
                const max = config?.max || 100;
                const id = Math.random().toString(36).substring(2, 15);
                ops.op_ui_widget_slider(windowId, label, value, min, max, id);

                if (config?.onChange) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onChange;
                }
            },
            numericInput: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || 0;
                const id = Math.random().toString(36).substring(2, 15);
                ops.op_ui_widget_numeric_input(windowId, label, value, id);

                if (config?.onChange) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onChange;
                }
            }
        }
    },
    _process_events: (events) => {
        for (const event of events) {
            let id = event;
            let payload = null;

            ops.op_println(String("Process Addon Event: " + event));

            if (event.includes("|")) {
                const parts = event.split("|");
                id = parts[0];
                payload = parts[1];
            }

            if (globalThis._entropy_event_listeners && globalThis._entropy_event_listeners[id]) {
                if (payload !== null) {
                    // Try to parse payload if it looks like a color or array
                    if (payload.includes(",")) {
                        const values = payload.split(",").map(v => parseFloat(v));
                        globalThis._entropy_event_listeners[id](values);
                    } else {
                        globalThis._entropy_event_listeners[id](payload);
                    }
                } else {
                    globalThis._entropy_event_listeners[id]();
                }
            }
        }
    },
    Pipeline: {
        create: (config) => {
            return ops.op_pipeline_create({
                ...config,
                lightingBindings: config.lightingBindings || null
            });
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
            // This is for Global. There is another createHair defined here!
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
                baseColor: config.baseColor || [0.1, 0.4, 0.1, 1.0],
                tipColor: config.tipColor || [0.4, 0.8, 0.2, 1.0],
                pipelineId: config.pipelineId || null,
                bindings: config.bindings || []
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
    Lighting: {
        createPointLight: (config) => {
            return ops.op_point_light_create("Global", {
                position: config.position || [0, 0, 0],
                color: config.color || [1, 1, 1],
                intensity: config.intensity || 1.0,
                maxDistance: config.maxDistance || 20.0
            });
        }
    },
    Audio: {
        playSynth: (config) => {
            ops.op_audio_play_synth({
                freq: config.freq || 440.0,
                waveform: config.waveform || "sine",
                duration: config.duration || 0.5,
                cutoff: config.cutoff || 20000.0,
                gain: config.gain || 0.2
            });
        },
        playTestTone: () => {
            ops.op_audio_play_test();
        }
    },
    println: (msg) => {
        ops.op_println(String(msg));
    }
};

// IO Namespace (Scoped to addon)
globalThis.Entropy.IO = {
    // This is a placeholder, actual implementation needs scoped metadata.name access.
    // However, globalThis.Entropy structure is static.
    // The `register` function returns the SCOPED API.
    // So we should add IO to the returned object in `register`.
};

// Composer Registry (Global)
globalThis.Entropy.Composer = {
    editors: {},
    registerEditor: (addonName, renderFn) => {
        globalThis.Entropy.Composer.editors[addonName] = renderFn;
    },
    getEditor: (addonName) => {
        return globalThis.Entropy.Composer.editors[addonName];
    }
};

// Convenience global
globalThis.println = globalThis.Entropy.println;

export {};
