const addonInfo = {
    name: "Model Viewer",
    version: "1.1.0",
    description: "Load and view 3D models with physics support",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

interface ModelInstance {
    id: string;
    path: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
}

let state: {
    models: ModelInstance[];
    activeModelId: string | null;
} = {
    models: [],
    activeModelId: null
};

function refreshModels() {
    // Clear previously loaded models by this addon
    // Note: op_meshes_clear now also clears addon_models in Rust
    addon.Model.clearMeshes();
    
    state.models.forEach(m => {
        addon.Model.load({
            id: m.id,
            path: m.path,
            position: m.position,
            rotation: m.rotation,
            scale: m.scale
        });
    });
}

// Register as a renderer for Game Composer
if (Entropy.Composer) {
    Entropy.Composer.registerRenderer(addonInfo.name, (id, params) => {
        // This allows Game Composer to spawn models managed by this addon
        if (params._transform) {
            addon.Model.load({
                id: id,
                path: params.path || "Player.glb",
                position: params._transform.position,
                rotation: params._transform.rotation || [0, 0, 0],
                scale: params._transform.scale
            });
        }
    });
}

addon.onInit(async () => {
    Entropy.println("Model Viewer Addon Initialized");

    const loadData = () => {
        const saved = addon.IO.load();
        if (saved) {
            state = { ...state, ...saved };
            refreshModels();
        }
    };

    addon.onProjectChanged(() => {
        loadData();
    });

    const tabId = addon.UI.createTab({
        title: "Model Viewer",
        onRender: () => {
            Entropy.UI.Widget.label(tabId, { text: "📦 Model Viewer", bold: true });

            Entropy.UI.Widget.button(tabId, {
                text: "📂 Pick & Import Model",
                onClick: async () => {
                    if (addon.IO.pickAndImportModel!) {
                        const fileName = await addon.IO.pickAndImportModel();
                        if (fileName && fileName !== "") {
                            const id = Entropy.generateUUID();
                            const newModel: ModelInstance = {
                                id,
                                path: fileName,
                                position: [0, 10, 0],
                                rotation: [0, 0, 0],
                                scale: [1, 1, 1]
                            };
                            state.models.push(newModel);
                            state.activeModelId = id;
                            refreshModels();
                        }
                    }
                }
            });

            Entropy.UI.Widget.label(tabId, { text: "--- Scene Models ---", bold: true });
            if (state.models.length === 0) {
                Entropy.UI.Widget.label(tabId, { text: "(No models loaded)" });
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
                    text: "🗑️ Delete Model",
                    onClick: () => {
                        state.models = state.models.filter(m => m.id !== activeModel.id);
                        state.activeModelId = null;
                        refreshModels();
                    }
                });

                // Register this model as a component for other addons (like Game Composer)
                Entropy.UI.Widget.button(tabId, {
                    text: "➕ Register as Component",
                    onClick: () => {
                        if (Entropy.Composer) {
                            Entropy.Composer.registerComponent(addonInfo.name, activeModel.path, activeModel.path, {
                                path: activeModel.path
                            });
                            Entropy.println("Registered " + activeModel.path + " as component");
                        }
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
});