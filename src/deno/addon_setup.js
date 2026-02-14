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
                onUpdatePlus: (addonName, callback) => {
                    ops.op_addon_on_update(addonName, (time, pos, dir) => {
                        callback(time, pos, dir);
                    });
                },
                onCleanup: (callback) => {
                    ops.op_addon_on_cleanup(metadata.name, callback);
                },
                onProjectChanged: (callback) => {
                    ops.op_addon_on_project_changed(metadata.name, callback);
                    
                    // automatically call on init hooks
                    if (globalThis.Entropy.Composer && typeof globalThis.Entropy.Composer.initCallbacks[metadata.name] === "function") {
                        try {
                            globalThis.Entropy.Composer.initCallbacks[metadata.name]();
                        } catch (e) {
                            ops.op_println("Error in Composer initCallback for " + metadata.name + ": " + e);
                        }
                    }
                },
                onAllProjectsLoaded: (callback) => {
                    ops.op_addon_on_all_projects_loaded(metadata.name, callback);
                },
                getAddon: (name) => {
                    return globalThis.__ENTROPY_ADDONS__?.getAddon(name);
                },
                getVisual: (name) => {
                    return globalThis.__ENTROPY_ADDONS__?.getVisual(name);
                },
                getVisualProvider: (name) => {
                    return globalThis.__ENTROPY_ADDONS__?.getVisualProvider(name);
                },
                registerVisual: (name, provider) => {
                    return globalThis.__ENTROPY_ADDONS__?.registerVisual(name, provider);
                },
                registerTool: (definition, callback) => {
                    ops.op_addon_register_tool(definition, callback);
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
                        const id = config.id || null;
                        if (id && config.visualName) {
                            globalThis.Entropy._entityVisuals = globalThis.Entropy._entityVisuals || {};
                            globalThis.Entropy._entityVisuals[id] = config.visualName;
                        }

                        ops.op_model_load(getAddonName(), {
                            id: id,
                            path: config.path,
                            visualType: config.visualType || null,
                            modelId: config.modelId || null,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1],
                            pipeline_id: config.pipelineId || null,
                            render_role: config.renderRole || null,
                            physics: config.physics || null,
                            player: config.player || null,
                            npc: config.npc || null,
                            behaviorId: config.behaviorId || null,
                            isNpc: config.isNpc || null
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
                            bindings: config.bindings || [],
                            behaviorId: config.behaviorId || null,
                            isNpc: config.isNpc || null,
                            player: config.player || null
                        });
                    },
                    clearMesh: (meshId) => {
                        ops.op_mesh_clear(getAddonName(), meshId);
                    },
                    clearMeshes: () => {
                        ops.op_meshes_clear(getAddonName());
                    },
                    setBoneTransform: (config) => {
                        ops.op_model_set_bone_transform(config);
                    }
                },
                Visual: {
                    load: (config) => {
                        const id = config.id || null;
                        if (id && config.visualName) {
                            globalThis.Entropy._entityVisuals = globalThis.Entropy._entityVisuals || {};
                            globalThis.Entropy._entityVisuals[id] = config.visualName;
                        }

                        ops.op_visual_load(getAddonName(), {
                            id: id,
                            visualName: config.visualName,
                            templateId: config.meshId || config.modelPath,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1],
                            pipelineId: config.pipelineId || null,
                            renderRole: config.renderRole || null,
                            physics: config.physics || null,
                            player: config.player || null,
                            npc: config.npc || null,
                            behaviorId: config.behaviorId || null,
                            isNpc: config.isNpc || null
                        });
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
                            render_role: config.renderRole || null,
                            size: config.size,
                            scale: config.scale
                        });
                    },
                    updateTexture: (textureId, kind) => {
                        ops.op_landscape_update_texture(getAddonName(), textureId, kind);
                    },
                    updatePbrTexture: (textureId, kind, materialType) => {
                        ops.op_landscape_update_pbr_texture(getAddonName(), textureId, kind, materialType);
                    },
                    updateTexturePlus: (addonName, textureId, kind) => {
                        // ops.op_println(String("updateTexturePlus: " + metadata.name + " " + addonName + " " + textureId + " " + kind));
                        ops.op_landscape_update_texture(addonName, textureId, kind);
                    },
                    updatePbrTexturePlus: (addonName, textureId, kind, materialType) => {
                        // ops.op_println(String("updatePbrTexturePlus: " + metadata.name + " " + addonName + " " + textureId + " " + kind + " " + materialType));
                        ops.op_landscape_update_pbr_texture(addonName, textureId, kind, materialType);
                    },
                    getHeightAt: (x, z) => {
                        return ops.op_landscape_get_height(x, z);
                    }
                },
                Collectable: {
                    create: (config) => {
                        const id = globalThis.Entropy.generateUUID();
                        // For now, we represent collectables as small models/cubes
                        ops.op_model_load(getAddonName(), {
                            id,
                            path: config.modelPath || "Cube.glb",
                            position: config.position,
                            scale: [0.5, 0.5, 0.5],
                            physics: {
                                bodyType: "fixed",
                                colliderShape: "cuboid"
                            }
                        });
                        
                        globalThis.Entropy._collectables = globalThis.Entropy._collectables || {};
                        globalThis.Entropy._collectables[id] = config;
                        return id;
                    },
                    remove: (id) => {
                        ops.op_meshes_clear(getAddonName()); // Note: this clears ALL meshes for the addon context. 
                        // In a better version we'd have clearMesh(id).
                        if (globalThis.Entropy._collectables) delete globalThis.Entropy._collectables[id];
                    }
                },
                Quest: {
                    create: (id, config) => {
                        globalThis.Entropy._quests = globalThis.Entropy._quests || {};
                        globalThis.Entropy._quests[id] = { ...config, completed: false, status: "active" };
                    },
                    updateObjective: (id, index, completed) => {
                        if (globalThis.Entropy._quests && globalThis.Entropy._quests[id]) {
                            // Logic for objective tracking
                        }
                    },
                    getStatus: (id) => {
                        return globalThis.Entropy._quests ? globalThis.Entropy._quests[id] : null;
                    }
                },
                Inventory: {
                    addItem: (playerId, itemId, quantity) => {
                        globalThis.Entropy._inventories = globalThis.Entropy._inventories || {};
                        globalThis.Entropy._inventories[playerId] = globalThis.Entropy._inventories[playerId] || {};
                        globalThis.Entropy._inventories[playerId][itemId] = (globalThis.Entropy._inventories[playerId][itemId] || 0) + quantity;
                    },
                    removeItem: (playerId, itemId, quantity) => {
                        if (globalThis.Entropy._inventories && globalThis.Entropy._inventories[playerId]) {
                            globalThis.Entropy._inventories[playerId][itemId] = Math.max(0, (globalThis.Entropy._inventories[playerId][itemId] || 0) - quantity);
                        }
                    },
                    hasItem: (playerId, itemId) => {
                        return globalThis.Entropy._inventories && globalThis.Entropy._inventories[playerId] && globalThis.Entropy._inventories[playerId][itemId] > 0;
                    }
                },
                GameState: {
                    save: (key, data) => {
                        ops.op_addon_save_data("GlobalGameState_" + key, JSON.stringify(data));
                    },
                    load: (key) => {
                        const json = ops.op_addon_load_data("GlobalGameState_" + key);
                        return json ? JSON.parse(json) : null;
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
                        // ops.op_println(String("CreateOrUpdate Hair (2): " + getAddonName() + " " + JSON.stringify(merged_config.baseColor)+ " " + JSON.stringify(merged_config.tipColor)));
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
                    update: (textureId, data) => {
                        return ops.op_texture_update(textureId, data);
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
                Scripts: {
                    list: () => {
                        return ops.op_script_list();
                    },
                    read: (filename) => {
                        return ops.op_script_read(filename);
                    },
                    write: (filename, content) => {
                        return ops.op_script_write(filename, content);
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
    Behavior: {
        register: (id, hooks) => {
            ops.op_behavior_register(
                id,
                hooks.onUpdate || null,
                hooks.onInteract || null,
                hooks.onAttack || null
            );
        }
    },
    Entity: {
        applyImpulse: (id, impulse) => {
            // ops.op_println("Applying impulse");
            ops.op_entity_apply_impulse(id, impulse);
        },
        setVelocity: (id, velocity) => {
            // ops.op_println("Applying velocity");
            ops.op_entity_set_velocity(id, velocity);
        },
        setXZVelocity: (id, velocity) => {
            ops.op_entity_set_xz_velocity(id, velocity);
        },
        setRotation: (id, rotation) => {
            ops.op_entity_set_rotation(id, rotation);
        },
        playAnimation: (id, animName) => {
            globalThis.Entropy._entityAnimations = globalThis.Entropy._entityAnimations || {};
            globalThis.Entropy._entityAnimations[id] = animName;
            
            // Trigger Visual Provider if applicable
            const visualName = globalThis.Entropy._entityVisuals?.[id];
            if (visualName && globalThis.__ENTROPY_ADDONS__) {
                const provider = globalThis.__ENTROPY_ADDONS__.getVisualProvider(visualName);
                if (provider && provider.onAnimate) {
                    provider.onAnimate(id, animName);
                }
            }

            ops.op_entity_play_animation(id, animName);
        },
        getAnimation: (id) => {
            return globalThis.Entropy._entityAnimations?.[id] || "Idle";
        },
        setStats: (id, stats) => {
            ops.op_entity_set_stats(id, stats);
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
        miniMap: (windowId, config) => {
            globalThis.Entropy.UI.Widget.miniMap(windowId, config);
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
            },
            checkbox: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || false;
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_" + label + "_" + count);
                globalThis._entropy_widget_counter = count + 1;

                ops.op_ui_widget_checkbox(windowId, label, value, id);

                if (config?.onChange) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onChange;
                }
            },
            codeEditor: (windowId, config) => {
                const label = config?.label || "";
                const content = config?.content || "";
                const language = config?.language || "javascript";
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_" + label + "_" + count);
                globalThis._entropy_widget_counter = count + 1;

                ops.op_ui_widget_code_editor(windowId, label, content, language, id);

                if (config?.onChange) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onChange;
                }
            },
            miniMap: (windowId, config) => {
                const landscapeId = config?.landscapeId || "Global";
                const brushSize = config?.brushSize || 5.0;
                const markers = config?.markers || [];
                const polylines = config?.polylines || [];
                const count = (globalThis._entropy_widget_counter || 0);
                const id = config?.id || (windowId + "_minimap_" + count);
                globalThis._entropy_widget_counter = count + 1;

                ops.op_ui_widget_mini_map(windowId, landscapeId, brushSize, markers, polylines, id);

                if (config?.onDraw) {
                    globalThis._entropy_event_listeners = globalThis._entropy_event_listeners || {};
                    globalThis._entropy_event_listeners[id] = config.onDraw;
                }

                if (config?.onHover) {
                    globalThis._entropy_hover_listeners = globalThis._entropy_hover_listeners || {};
                    globalThis._entropy_hover_listeners[id] = config.onHover;
                }

                if (config?.onClick) {
                    globalThis._entropy_click_listeners = globalThis._entropy_click_listeners || {};
                    globalThis._entropy_click_listeners[id] = config.onClick;
                }
            },
            separator: (windowId) => {
                ops.op_ui_widget_separator(windowId);
            }
        }
    },
    _process_events: (events) => {
        for (const event of events) {
            let id = event;
            let payload = null;
            let isHover = false;
            let isClick = false;

            // ops.op_println(String("Process Addon Event: " + event));

            if (event.startsWith("HOVER|")) {
                isHover = true;
                const parts = event.split("|");
                id = parts[1];
                payload = parts[2];
            } else if (event.startsWith("CLICK|")) {
                isClick = true;
                const parts = event.split("|");
                id = parts[1];
                payload = parts[2];
            } else if (event.includes("|")) {
                const parts = event.split("|");
                id = parts[0];
                payload = parts[1];
            }

            const listener_pool = isHover ? globalThis._entropy_hover_listeners : 
                                 isClick ? globalThis._entropy_click_listeners :
                                 globalThis._entropy_event_listeners;

            if (listener_pool && listener_pool[id]) {
                if (payload !== null) {
                    // Try to parse payload if it looks like a color or array or drawing event
                    if (payload.includes(",")) {
                        const values = payload.split(",").map(v => parseFloat(v));
                        
                        // For minimap draw/hover events: x, y, brushSize
                        if (values.length === 3) {
                             listener_pool[id](values[0], values[1], values[2]);
                        } else {
                             listener_pool[id](values);
                        }
                    } else {
                        listener_pool[id](payload);
                    }
                } else {
                    listener_pool[id]();
                }
            }
        }
    },
    _process_game_logic: () => {
        if (!globalThis.Entropy.gameMode) return;
        
        const [playerPos] = globalThis.Entropy.Camera.getTransform();
        const collectables = globalThis.Entropy._collectables;
        
        if (collectables) {
            for (const id in collectables) {
                const config = collectables[id];
                const dx = playerPos[0] - config.position[0];
                const dy = playerPos[1] - config.position[1];
                const dz = playerPos[2] - config.position[2];
                const distSq = dx*dx + dy*dy + dz*dz;
                
                if (distSq < 4.0) { // 2.0 meters radius
                    if (config.onCollect) {
                        try {
                            config.onCollect("player"); // We'll use a fixed ID for now or find it
                        } catch(e) {
                            globalThis.Entropy.println("Error in onCollect: " + e);
                        }
                    }
                    globalThis.Entropy.Collectable.remove(id);
                }
            }
        }
    },
    _game_events: {
        started: [],
        stopped: []
    },
    onGameStarted: (cb) => {
        globalThis.Entropy._game_events.started.push(cb);
    },
    onGameStopped: (cb) => {
        globalThis.Entropy._game_events.stopped.push(cb);
    },
    _dispatchGameStarted: () => {
        globalThis.Entropy.println("[Game Hooks] Dispatching Game Started. Event Count: " + globalThis.Entropy._game_events.started.length);
        globalThis.Entropy._game_events.started.forEach(cb => {
            try { cb(); } catch(e) { globalThis.Entropy.println("Error in onGameStarted callback: " + e); }
        });
    },
    _dispatchGameStopped: () => {
        globalThis.Entropy.println("[Game Hooks] Dispatching Game Stopped. Event Count: " + globalThis.Entropy._game_events.stopped.length);
        globalThis.Entropy._game_events.stopped.forEach(cb => {
            try { cb(); } catch(e) { globalThis.Entropy.println("Error in onGameStopped callback: " + e); }
        });
    },
    _process_input_events: (events) => {
        globalThis.Entropy._process_game_logic?.();
        if (!globalThis._entropy_input_listeners) return;
        const listeners = globalThis._entropy_input_listeners;

        for (const event of events) {
            switch (event.type) {
                case "MouseDown":
                    if (listeners.onMouseDown) listeners.onMouseDown(event.button, event.x, event.y);
                    break;
                case "MouseMove":
                    if (listeners.onMouseMove) listeners.onMouseMove(event.x, event.y);
                    break;
                case "MouseUp":
                    if (listeners.onMouseUp) listeners.onMouseUp(event.button);
                    break;
                case "KeyDown":
                    // We need modifiers here too if requested by API
                    // For now keeping it simple as per NEEDED_APIS.md
                    if (listeners.onKeyDown) {
                        const state = ops.op_input_get_state();
                        listeners.onKeyDown(event.key, state.modifiers.ctrl, state.modifiers.shift, state.modifiers.alt);
                    }
                    break;
                case "KeyUp":
                    if (listeners.onKeyUp) listeners.onKeyUp(event.key);
                    break;
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
        update: (textureId, data) => {
            return ops.op_texture_update(textureId, data);
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
    setGameMode: (enabled) => {
        ops.op_set_game_mode(enabled);
    },
    Camera: {
        getTransform: () => {
            return ops.op_camera_get_transform();
        },
        screenToWorldRay: (screenX, screenY) => {
            const [pos, dir] = ops.op_camera_get_transform(); // Default fallback
            try {
                const [w, h] = ops.op_window_get_size();
                return ops.op_camera_screen_to_world(screenX, screenY, w, h);
            } catch (e) {
                return { origin: pos, direction: dir };
            }
        }
    },
    Gizmo: {
        show: (config) => {
            const id = globalThis.Entropy.generateUUID();
            ops.op_gizmo_show({
                id,
                position: config.position,
                mode: config.mode,
                space: config.space || "world"
            });
            // We'll store callbacks globally for the engine to trigger
            globalThis._entropy_gizmo_callbacks = globalThis._entropy_gizmo_callbacks || {};
            globalThis._entropy_gizmo_callbacks[id] = {
                onTransform: config.onTransform,
                onComplete: config.onComplete
            };
            return id;
        },
        hide: (id) => {
            ops.op_gizmo_hide();
            if (globalThis._entropy_gizmo_callbacks) {
                delete globalThis._entropy_gizmo_callbacks[id];
            }
        },
        updatePosition: (id, position) => {
            ops.op_gizmo_update(position[0], position[1], position[2]);
        },
        getState: (id) => {
            // Need op_gizmo_get_state if we want to poll it
            return null; 
        }
    },
    Input: {
        onMouseDown: (callback) => {
            globalThis._entropy_input_listeners = globalThis._entropy_input_listeners || {};
            globalThis._entropy_input_listeners.onMouseDown = callback;
        },
        onMouseMove: (callback) => {
            globalThis._entropy_input_listeners = globalThis._entropy_input_listeners || {};
            globalThis._entropy_input_listeners.onMouseMove = callback;
        },
        onMouseUp: (callback) => {
            globalThis._entropy_input_listeners = globalThis._entropy_input_listeners || {};
            globalThis._entropy_input_listeners.onMouseUp = callback;
        },
        onKeyDown: (callback) => {
            globalThis._entropy_input_listeners = globalThis._entropy_input_listeners || {};
            globalThis._entropy_input_listeners.onKeyDown = callback;
        },
        onKeyUp: (callback) => {
            globalThis._entropy_input_listeners = globalThis._entropy_input_listeners || {};
            globalThis._entropy_input_listeners.onKeyUp = callback;
        },
        isKeyPressed: (key) => {
            const state = ops.op_input_get_state();
            return state.pressedKeys.includes(key);
        },
        isCtrlPressed: () => {
            const state = ops.op_input_get_state();
            return state.modifiers.ctrl;
        },
        isShiftPressed: () => {
            const state = ops.op_input_get_state();
            return state.modifiers.shift;
        },
        isAltPressed: () => {
            const state = ops.op_input_get_state();
            return state.modifiers.alt;
        }
    },
    Selection: {
        setMode: (mode) => {
            // op_selection_set_mode(mode)
        },
        getSelected: (meshId) => {
            const selectedId = ops.op_selection_get_selected();
            // Basic object selection for now
            return {
                vertices: [],
                edges: [],
                faces: [],
                objectId: selectedId === "" ? null : selectedId
            };
        },
        raycast: (screenX, screenY) => {
            // Need op_selection_raycast
            return null;
        },
        highlightElements: (meshId, config) => {
            // op_selection_highlight(meshId, config)
        },
        clear: () => {
            // op_selection_clear()
        }
    },
    Mesh: {
        getData: (meshId) => {
            return ops.op_mesh_get_data(meshId);
        },
        updateVertices: (meshId, vertexIndices, newPositions) => {
            // Check if it's a full update or partial
            // For now we'll pass it to native, which might just log or do partial buffer write
            ops.op_mesh_update_vertices(meshId, vertexIndices, newPositions);
        },
        appendGeometry: (meshId, vertices, indices) => {
            // op_mesh_append_geometry(meshId, vertices, indices)
        },
        removeGeometry: (meshId, faceIndices) => {
            // op_mesh_remove_geometry(meshId, faceIndices)
        },
        getVertexWorldPosition: (meshId, vertexIndex) => {
            // Need op_mesh_get_vertex_world_pos
            return [0, 0, 0];
        },
        recalculateNormals: (meshId) => {
            // op_mesh_recalculate_normals(meshId)
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

globalThis.Entropy.Composite = {
  register: (name, textureId, pipelineId, bindings = []) => {
    const target = globalThis.__entropy_current_addon_context_override || "Global";
    ops.op_register_composite_texture(target, { name, textureId, pipelineId, bindings });
  }
};

// Composer Registry (Global)
globalThis.Entropy.Composer = {
    editors: {},
    renderers: {}, // addonName -> renderFn(id, params)
    games: {}, // addonName -> renderFn(id, params)
    textureGenerators: {}, // addonName -> (id, params, resolution) => { diffId, norId, armId }
    components: {}, // addonName -> { componentId -> { name, params } }
    initCallbacks: {}, // addonName -> initCallback()
    globalSettings: {
        landscapeSettings: {
            size: 1024,
            height: 150,
            yOffset: -200
        }
    },
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
    registerTextureGenerator: (addonName, generatorFn) => {
        globalThis.Entropy.Composer.textureGenerators[addonName] = generatorFn;
    },
    getTextureGenerator: (addonName) => {
        return globalThis.Entropy.Composer.textureGenerators[addonName];
    },
    getGame: (gameName) => {
        return globalThis.Entropy.Composer.games[gameName];
    },
    registerGame: (gameName, renderFn) => {
        globalThis.Entropy.Composer.games[gameName] = renderFn;
    },
    registerComponent: (addonName, componentId, name, params) => {
        if (!globalThis.Entropy.Composer.components[addonName]) {
            globalThis.Entropy.Composer.components[addonName] = {};
        }
        globalThis.Entropy.Composer.components[addonName][componentId] = { id: componentId, name, params };
    },
    getComponents: (addonName) => {
        return globalThis.Entropy.Composer.components[addonName] || {};
    },
    setRolePipeline: (role, pipelineId) => {
        ops.op_composer_set_role_pipeline(role, pipelineId);
    },
    enableGameComposerOverride: () => {
        globalThis.__entropy_current_addon_context_override = "Game Composer";
    },
    disableGameComposerOverride: () => {
        globalThis.__entropy_current_addon_context_override = null;
    },
    enableOverride: (name) => {
        globalThis.__entropy_current_addon_context_override = name;
    },
    disableOverride: () => {
        globalThis.__entropy_current_addon_context_override = null;
    },
    setGlobalSettings: (settings) => {
        globalThis.Entropy.Composer.globalSettings = settings;
    },
    getGlobalSettings: () => {
        return globalThis.Entropy.Composer.globalSettings;
    }
};

globalThis._createSystem = () => {
    return {
        spawn_particles: (pos, color, grav) => {
            // Need to make sure op_system_spawn_particles is registered in addon_engine.rs too!
            // Actually let's assume we'll add it or use a different way.
            // For now, mirroring old setup.js
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

// Convenience global
globalThis.println = globalThis.Entropy.println;

export {};