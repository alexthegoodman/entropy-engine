const { ops } = Deno.core;

globalThis.Entropy = {
    Addon: {
        register: (metadata) => {
            ops.op_addon_register(metadata);
            
            const getAddonName = () => globalThis.__entropy_current_addon_context_override || metadata.name;

            // Return scoped API
            return {
                onInit: (callback) => {
                    ops.op_addon_on_init(metadata.name, callback);
                },
                onAllAddonsInitialized: (callback) => {
                    ops.op_addon_on_all_addons_initialized(callback);
                },
                onUpdate: (callback) => {
                    ops.op_addon_on_update(metadata.name, (time, pos, dir) => {
                        callback(time, pos, dir);
                    });
                },
                onCleanup: (callback) => {
                    ops.op_addon_on_cleanup(metadata.name, callback);
                },
                onProjectChanged: (callback) => {
                    ops.op_addon_on_project_changed(metadata.name, callback);
                },
                setVisibility: (visible) => {
                    ops.op_addon_set_visibility(metadata.name, visible);
                },
                UI: {
                    createTab: (config) => {
                        const tabId = ops.op_ui_create_tab(metadata.name, config, config.onRender);
                        return tabId;
                    },
                },
                Model: {
                    load: (config) => {
                        ops.op_model_load(getAddonName(), {
                            id: config.id || null,
                            path: config.path,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1],
                            pipeline_id: config.pipelineId || null,
                            render_role: config.renderRole || null
                        });
                    },
                    createProcedural: (config) => {
                        if (config.type === "cube") {
                            ops.op_cube_spawn(getAddonName(), {
                                position: config.parameters?.position || [0, 0, 0],
                                scale: config.parameters?.scale || [1, 1, 1],
                                pipeline_id: config.pipelineId || null,
                                render_role: config.renderRole || null
                            });
                        }
                    },
                    createMesh: (config) => {
                        ops.op_mesh_create(getAddonName(), {
                            id: config.id || null,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1],
                            vertexData: config.vertexData || [],
                            indexData: config.indexData || [],
                            pipelineId: config.pipelineId,
                            render_role: config.renderRole || null,
                            instanceCount: config.instanceCount || 1,
                            bindings: config.bindings || []
                        });
                    },
                    clearMesh: (meshId) => {
                        ops.op_mesh_clear(getAddonName(), meshId);
                    },
                    clearMeshes: () => {
                        ops.op_meshes_clear(getAddonName());
                    }
                },
                Landscape: {
                    create: (config) => {
                        ops.op_landscape_create(getAddonName(), {
                            id: config.id || null,
                            width: config.width,
                            height: config.height,
                            heights: config.heights || null,
                            noiseId: config.noiseId || null,
                            position: config.position || [0, 0, 0],
                            pipelineId: config.pipelineId || null,
                            render_role: config.renderRole || null
                        });
                    },
                    updateTexture: (textureId, kind) => {
                        ops.op_landscape_update_texture(getAddonName(), textureId, kind);
                    },
                    updatePbrTexture: (textureId, kind, materialType) => {
                        ops.op_landscape_update_pbr_texture(getAddonName(), textureId, kind, materialType);
                    },
                    updateTexturePlus: (addonName, textureId, kind) => {
                        ops.op_println(String("updateTexturePlus: " + metadata.name + " " + addonName + " " + textureId + " " + kind));
                        ops.op_landscape_update_texture(addonName, textureId, kind);
                    },
                    updatePbrTexturePlus: (addonName, textureId, kind, materialType) => {
                        ops.op_println(String("updatePbrTexturePlus: " + metadata.name + " " + addonName + " " + textureId + " " + kind + " " + materialType));
                        ops.op_landscape_update_pbr_texture(addonName, textureId, kind, materialType);
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
                            render_role: config.renderRole || null,
                            bindings: config.bindings || []
                        };
                        ops.op_println(String("CreateOrUpdate Hair (2): " + getAddonName() + " " + JSON.stringify(merged_config.baseColor)+ " " + JSON.stringify(merged_config.tipColor)));
                        ops.op_grass_create(getAddonName(), merged_config);
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
                Texture: {
                    create: (width, height, data) => {
                        return ops.op_texture_create(width, height, data);
                    },
                    createStorage: (width, height, format = "Rgba32Float") => {
                        return ops.op_texture_create_ex({
                            width,
                            height,
                            format,
                            usage: ["Texture", "Storage", "CopyDst", "CopySrc"]
                        }, null);
                    },
                    createEx: (config, data = null) => {
                        return ops.op_texture_create_ex(config, data);
                    },
                    load: (filename) => {
                        return ops.op_texture_load(filename);
                    }
                },
                Lighting: {
                    createPointLight: (config) => {
                        ops.op_point_light_create(getAddonName(), {
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
                        ops.op_println(String("Saving Data: " + metadata.name));
                        ops.op_addon_save_data(metadata.name, JSON.stringify(data));
                    },
                    saveImage: (filename, width, height, data) => {
                        ops.op_addon_save_image(metadata.name, filename, width, height, data);
                    },
                    listModels: () => {
                        return ops.op_io_list_models();
                    },
                    pickAndImportModel: () => {
                        return ops.op_io_pick_and_import_model();
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
                },
                Buffer: {
                    create: (config) => {
                        return ops.op_buffer_create({
                            size: BigInt(config.size),
                            usage: config.usage || "Storage"
                        });
                    },
                    write: (bufferId, data, offset = 0) => {
                        // Ensure data is a typed array for the buffer op
                        const bufferData = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
                        ops.op_buffer_write(bufferId, BigInt(offset), bufferData);
                    }
                },
                Compute: {
                    createPipeline: (config) => {
                        return ops.op_compute_pipeline_create({
                            name: config.name || "unnamed_compute",
                            shaderSource: config.shaderSource,
                            bindGroups: config.bindGroups || []
                        });
                    },
                    dispatch: (config) => {
                        ops.op_compute_dispatch({
                            pipelineId: config.pipelineId,
                            groups: config.groups || [1, 1, 1],
                            bindings: config.bindings || []
                        });
                    }
                }
            };
        },
        setVisibility: (addonName, visible) => {
            ops.op_addon_set_visibility(addonName, visible);
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
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_" + text + "_" + count);
                globalThis._entropy_widget_counter = count + 1;
                
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
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_" + label + "_" + count);
                globalThis._entropy_widget_counter = count + 1;

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
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_" + label + "_" + count);
                globalThis._entropy_widget_counter = count + 1;

                ops.op_ui_widget_slider(windowId, label, value, min, max, id);

                if (config?.onChange) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onChange;
                }
            },
            numericInput: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || 0;
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_" + label + "_" + count);
                globalThis._entropy_widget_counter = count + 1;

                ops.op_ui_widget_numeric_input(windowId, label, value, id);

                if (config?.onChange) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onChange;
                }
            },
            dropdown: (windowId, config) => {
                const label = config?.label || "";
                const options = config?.options || [];
                const selectedIndex = BigInt(config?.selectedIndex || 0);
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_" + label + "_" + count);
                globalThis._entropy_widget_counter = count + 1;

                ops.op_ui_widget_dropdown(windowId, label, options, selectedIndex, id);

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
    _reset_widget_counter: () => {
        globalThis._entropy_widget_counter = 0;
    },
    Pipeline: {
        create: (config) => {
            return ops.op_pipeline_create({
                ...config,
                lightingBindings: config.lightingBindings || null
            });
        },
        createCompute: (config) => {
            return ops.op_compute_pipeline_create({
                name: config.name || "unnamed_compute",
                shaderSource: config.shaderSource,
                bindGroups: config.bindGroups || []
            });
        }
    },
    Compute: {
        dispatch: (config) => {
            ops.op_compute_dispatch({
                pipelineId: config.pipelineId,
                groups: config.groups || [1, 1, 1],
                bindings: config.bindings || []
            });
        }
    },
    Buffer: {
        create: (config) => {
            return ops.op_buffer_create({
                size: BigInt(config.size),
                usage: config.usage || "Storage"
            });
        },
        write: (bufferId, data, offset = 0) => {
            const bufferData = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
            ops.op_buffer_write(bufferId, BigInt(offset), bufferData);
        }
    },
    Landscape: {
        create: (config) => {
            const target = globalThis.__entropy_current_addon_context_override || "Global";
            return ops.op_landscape_create(target, {
                id: config.id || null,
                width: config.width,
                height: config.height,
                heights: config.heights || null,
                noiseId: config.noiseId || null,
                position: config.position || [0, 0, 0],
                pipelineId: config.pipelineId || null,
                render_role: config.renderRole || null
            });
        }
    },
    Particles: {
        createHair: (config) => {
            const target = globalThis.__entropy_current_addon_context_override || "Global";
            return ops.op_grass_create(target, {
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
                render_role: config.renderRole || null,
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
    Texture: {
        create: (width, height, data) => {
            return ops.op_texture_create(width, height, data);
        },
        createStorage: (width, height, format = "Rgba32Float") => {
            return ops.op_texture_create_ex({
                width,
                height,
                format,
                usage: ["Texture", "Storage", "CopyDst", "CopySrc"]
            }, null);
        },
        createEx: (config, data = null) => {
            return ops.op_texture_create_ex(config, data);
        },
        load: (filename) => {
            return ops.op_texture_load(filename);
        }
    },
    Lighting: {
        createPointLight: (config) => {
            const target = globalThis.__entropy_current_addon_context_override || "Global";
            return ops.op_point_light_create(target, {
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
    },
    generateUUID: () => {
        return ops.op_generate_uuid();
    },
    Camera: {
        getTransform: () => {
            return ops.op_camera_get_transform();
        }
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
    renderers: {}, // addonName -> renderFn(id, params)
    components: {}, // addonName -> { componentId -> { name, params } }
    initCallbacks: {}, // addonName -> initCallback()
    registerEditor: (addonName, renderFn) => {
        globalThis.Entropy.Composer.editors[addonName] = renderFn;
    },
    getEditor: (addonName) => {
        return globalThis.Entropy.Composer.editors[addonName];
    },
    registerRenderer: (addonName, renderFn) => {
        globalThis.Entropy.Composer.renderers[addonName] = renderFn;
    },
    getRenderer: (addonName) => {
        return globalThis.Entropy.Composer.renderers[addonName];
    },
    registerComponent: (addonName, componentId, name, params) => {
        if (!globalThis.Entropy.Composer.components[addonName]) {
            globalThis.Entropy.Composer.components[addonName] = {};
        }
        globalThis.Entropy.Composer.components[addonName][componentId] = { name, params };
    },
    getComponents: (addonName) => {
        return globalThis.Entropy.Composer.components[addonName] || {};
    },
    setRolePipeline: (role, pipelineId) => {
        ops.op_composer_set_role_pipeline(role, pipelineId);
    }
};

// Convenience global
globalThis.println = globalThis.Entropy.println;

export {};