const addonInfo = {
    name: "Model Viewer",
    version: "1.3.0",
    description: "Load and view 3D models with physics support",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

type CharacterKind = "None" | "Player" | "NPC";

interface ModelInstance {
    id: string;
    path: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    kind: CharacterKind;
    npcProps?: {
        aggressiveness: number;
        combatType: "Melee" | "Ranged";
        wanderRadius: number;
        wanderSpeed: number;
        detectionRadius: number;
    };
}

let state: {
    models: ModelInstance[];
    activeModelId: string | null;
} = {
    models: [],
    activeModelId: null
};

let availableModels: string[] = [];

async function updateAvailableModels() {
    if (addon.IO.listModels) {
        availableModels = await addon.IO.listModels();
    }
}

function refreshModels() {
    // Clear previously loaded models by this addon
    addon.Model.clearMeshes();
    
    state.models.forEach(m => {
        const loadConfig: any = {
            id: m.id,
            path: m.path,
            position: m.position,
            rotation: m.rotation,
            scale: m.scale
        };

        if (m.kind === "Player") {
            loadConfig.player = { modelId: m.id };
        } else if (m.kind === "NPC" && m.npcProps) {
            loadConfig.npc = {
                modelId: m.id,
                behavior: {
                    ...m.npcProps,
                    meleeStats: {
                        damage: 10,
                        range: 2.5,
                        cooldown: 1.0,
                        windUpTime: 0.3,
                        recoveryTime: 0.3
                    }
                }
            };
        }

        addon.Model.load(loadConfig);

        // Auto-register as component
        if (Entropy.Composer) {
            Entropy.Composer.registerComponent(addonInfo.name, m.path, m.path, {
                path: m.path,
                kind: m.kind,
                npcProps: m.npcProps
            });
        }
    });
}

// Register as a renderer for Game Composer
if (Entropy.Composer) {
    Entropy.Composer.registerRenderer(addonInfo.name, (id, params) => {
        if (params._transform) {
            const loadConfig: any = {
                id: id,
                path: params.path || "Player.glb",
                position: params._transform.position,
                rotation: params._transform.rotation || [0, 0, 0],
                scale: params._transform.scale
            };

            if (params.kind === "Player") {
                loadConfig.player = { modelId: id };
            } else if (params.kind === "NPC" && params.npcProps) {
                loadConfig.npc = {
                    modelId: id,
                    behavior: {
                        ...params.npcProps,
                        meleeStats: {
                            damage: 10,
                            range: 2.5,
                            cooldown: 1.0,
                            windUpTime: 0.3,
                            recoveryTime: 0.3
                        }
                    }
                };
            }

            addon.Model.load(loadConfig);
        }
    });
}

addon.onInit(async () => {
    Entropy.println("Model Viewer Addon Initialized");

    const loadData = async () => {
        const saved = addon.IO.load();
        if (saved) {
            state = { ...state, ...saved };
            refreshModels();
        }
        await updateAvailableModels();
    };

    addon.onProjectChanged(async () => {
        await loadData();
    });

    await loadData();

    const tabId = addon.UI.createTab({
        title: "Model Viewer",
        onRender: () => {
            Entropy.UI.Widget.label(tabId, { text: "📦 Model Viewer", bold: true });

            Entropy.UI.Widget.button(tabId, {
                text: "📂 Import Model from Disk",
                onClick: async () => {
                    if (addon.IO.pickAndImportModel) {
                        const fileName = await addon.IO.pickAndImportModel();
                        if (fileName && fileName !== "") {
                            await updateAvailableModels();
                            // Automatically load it
                            let id = Entropy.generateUUID();
                            const newModel: ModelInstance = {
                                id,
                                path: fileName,
                                position: [0, 10, 0],
                                rotation: [0, 0, 0],
                                scale: [1, 1, 1],
                                kind: "None"
                            };
                            state.models.push(newModel);
                            state.activeModelId = id;
                            refreshModels();
                        }
                    }
                }
            });

            Entropy.UI.Widget.label(tabId, { text: "--- Available in Project ---", bold: true });
            if (availableModels.length === 0) {
                Entropy.UI.Widget.label(tabId, { text: "(No models in project folder)" });
            }

            availableModels.forEach(modelFile => {
                Entropy.UI.Widget.button(tabId, {
                    text: "➕ " + modelFile,
                    onClick: () => {
                        const id = Entropy.generateUUID();
                        const newModel: ModelInstance = {
                            id,
                            path: modelFile,
                            position: [0, 10, 0],
                            rotation: [0, 0, 0],
                            scale: [1, 1, 1],
                            kind: "None"
                        };
                        state.models.push(newModel);
                        state.activeModelId = id;
                        refreshModels();
                    }
                });
            });

            Entropy.UI.Widget.button(tabId, {
                text: "🔄 Refresh File List",
                onClick: async () => {
                    await updateAvailableModels();
                }
            });

            Entropy.UI.Widget.label(tabId, { text: "--- Active Scene Models ---", bold: true });
            if (state.models.length === 0) {
                Entropy.UI.Widget.label(tabId, { text: "(No models active)" });
            }

            state.models.forEach(m => {
                const isActive = m.id === state.activeModelId;
                Entropy.UI.Widget.button(tabId, {
                    text: (isActive ? "🔵 " : "⚪ ") + m.path + " (" + m.id.substring(0,4) + ")",
                    onClick: () => {
                        state.activeModelId = m.id;
                    }
                });
            });

            const activeModel = state.models.find(m => m.id === state.activeModelId);
            if (activeModel) {
                Entropy.UI.Widget.label(tabId, { text: "--- Inspector ---", bold: true });
                
                const kinds = ["None", "Player", "NPC"];
                Entropy.UI.Widget.dropdown(tabId, {
                    label: "Character Type",
                    options: kinds,
                    selectedIndex: kinds.indexOf(activeModel.kind),
                    onChange: (idx) => {
                        activeModel.kind = kinds[parseInt(idx)] as CharacterKind;
                        if (activeModel.kind === "NPC" && !activeModel.npcProps) {
                            activeModel.npcProps = {
                                aggressiveness: 0.5,
                                combatType: "Melee",
                                wanderRadius: 20.0,
                                wanderSpeed: 0.02,
                                detectionRadius: 30.0
                            };
                        }
                        refreshModels();
                    }
                });

                if (activeModel.kind === "NPC" && activeModel.npcProps) {
                    Entropy.UI.Widget.label(tabId, { text: "NPC Behavior", bold: true });
                    Entropy.UI.Widget.slider(tabId, { label: "Aggressiveness", value: activeModel.npcProps.aggressiveness, min: 0, max: 1, onChange: (v) => { activeModel.npcProps!.aggressiveness = parseFloat(v); refreshModels(); } });
                    Entropy.UI.Widget.slider(tabId, { label: "Detection Radius", value: activeModel.npcProps.detectionRadius, min: 5, max: 100, onChange: (v) => { activeModel.npcProps!.detectionRadius = parseFloat(v); refreshModels(); } });
                    Entropy.UI.Widget.slider(tabId, { label: "Wander Radius", value: activeModel.npcProps.wanderRadius, min: 0, max: 100, onChange: (v) => { activeModel.npcProps!.wanderRadius = parseFloat(v); refreshModels(); } });
                    Entropy.UI.Widget.slider(tabId, { label: "Speed", value: activeModel.npcProps.wanderSpeed, min: 0.001, max: 0.1, onChange: (v) => { activeModel.npcProps!.wanderSpeed = parseFloat(v); refreshModels(); } });
                    
                    const combatTypes = ["Melee", "Ranged"];
                    Entropy.UI.Widget.dropdown(tabId, {
                        label: "Combat Type",
                        options: combatTypes,
                        selectedIndex: combatTypes.indexOf(activeModel.npcProps.combatType),
                        onChange: (idx) => {
                            activeModel.npcProps!.combatType = combatTypes[parseInt(idx)] as "Melee" | "Ranged";
                            refreshModels();
                        }
                    });
                }

                Entropy.UI.Widget.label(tabId, { text: "Position" });
                Entropy.UI.Widget.slider(tabId, { label: "X", value: activeModel.position[0], min: -100, max: 100, onChange: (v) => { activeModel.position[0] = parseFloat(v); refreshModels(); } });
                Entropy.UI.Widget.slider(tabId, { label: "Y", value: activeModel.position[1], min: -50, max: 150, onChange: (v) => { activeModel.position[1] = parseFloat(v); refreshModels(); } });
                Entropy.UI.Widget.slider(tabId, { label: "Z", value: activeModel.position[2], min: -100, max: 100, onChange: (v) => { activeModel.position[2] = parseFloat(v); refreshModels(); } });

                Entropy.UI.Widget.label(tabId, { text: "Rotation (Radians)" });
                Entropy.UI.Widget.slider(tabId, { label: "X", value: activeModel.rotation[0], min: -3.14, max: 3.14, onChange: (v) => { activeModel.rotation[0] = parseFloat(v); refreshModels(); } });
                Entropy.UI.Widget.slider(tabId, { label: "Y", value: activeModel.rotation[1], min: -3.14, max: 3.14, onChange: (v) => { activeModel.rotation[1] = parseFloat(v); refreshModels(); } });
                Entropy.UI.Widget.slider(tabId, { label: "Z", value: activeModel.rotation[2], min: -3.14, max: 3.14, onChange: (v) => { activeModel.rotation[2] = parseFloat(v); refreshModels(); } });

                Entropy.UI.Widget.label(tabId, { text: "Scale" });
                Entropy.UI.Widget.slider(tabId, { label: "Uniform", value: activeModel.scale[0], min: 0.1, max: 10, onChange: (v) => { 
                    const s = parseFloat(v); 
                    activeModel.scale = [s, s, s]; 
                    refreshModels(); 
                }});

                Entropy.UI.Widget.button(tabId, {
                    text: "🗑️ Delete Instance",
                    onClick: () => {
                        state.models = state.models.filter(m => m.id !== activeModel.id);
                        state.activeModelId = null;
                        refreshModels();
                    }
                });
            }

            Entropy.UI.Widget.label(tabId, { text: "--------------------------------" });
            Entropy.UI.Widget.button(tabId, {
                text: "💾 Save State",
                onClick: () => {
                    addon.IO.save(state);
                    Entropy.println("Model Viewer state saved");
                }
            });
        }
    });

    // --- Tools Registration ---

    addon.registerTool({
        name: "list_available_models",
        description: "List all 3D model files (.glb) available in the project to be spawned.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return { success: true, models: availableModels };
    });

    addon.registerTool({
        name: "spawn_model",
        description: "Spawn a 3D model and register it as a component for the Game Composer.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "The filename of the model (e.g., 'Player.glb')." },
                name: { type: "string", description: "A friendly name for this model instance." },
                position: { type: "array", items: { type: "number" }, description: "[x, y, z] position." },
                rotation: { type: "array", items: { type: "number" }, description: "[x, y, z] rotation in radians." },
                scale: { type: "array", items: { type: "number" }, description: "[x, y, z] scale. Usually [1, 1, 1]." },
                kind: { type: "string", enum: ["None", "Player", "NPC"], description: "Character type." },
                npcProps: { 
                    type: "object", 
                    description: "NPC behavior settings.",
                    properties: {
                        aggressiveness: { type: "number", description: "Aggressiveness (0.0 to 1.0) (0.0 for friendly)" },
                        combatType: { type: "string", enum: ["Melee", "Ranged"], description: "Primary combat style" },
                        wanderRadius: { type: "number", description: "Random movement radius" },
                        wanderSpeed: { type: "number", description: "Movement speed multiplier" },
                        detectionRadius: { type: "number", description: "Player detection range" }
                    }
                }
            },
            required: ["path", "name"]
        }
    }, (args: any) => {
        const id = Entropy.generateUUID();
        
        // 1. Register component
        if (Entropy.Composer) {
            Entropy.Composer.registerComponent(addonInfo.name, args.path, args.name, {
                path: args.path,
                kind: args.kind || "None",
                npcProps: args.npcProps
            });
        }

        // 2. Load immediately
        const loadConfig: any = {
            id: id,
            path: args.path,
            position: args.position || [0, 0, 0],
            rotation: args.rotation || [0, 0, 0],
            scale: args.scale || [1, 1, 1]
        };

        if (args.kind === "Player") {
            loadConfig.player = { modelId: id };
        } else if (args.kind === "NPC" && args.npcProps) {
            loadConfig.npc = {
                modelId: id,
                behavior: {
                    ...args.npcProps,
                    meleeStats: {
                        damage: 10,
                        range: 2.5,
                        cooldown: 1.0,
                        windUpTime: 0.3,
                        recoveryTime: 0.3
                    }
                }
            };
        }

        addon.Model.load(loadConfig);

        return { success: true, id: id, name: args.name, addonName: addonInfo.name };
    });
});