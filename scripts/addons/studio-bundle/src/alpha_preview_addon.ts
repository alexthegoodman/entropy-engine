const addonInfo = {
    name: "Alpha Preview",
    version: "0.1.0",
    description: "Preview the new GPU-driven Alpha Renderer",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

let state: {
    models: any[];
} = {
    models: []
};

let availableModels: string[] = [];

async function updateAvailableModels() {
    if (addon.IO.listModels) {
        availableModels = await addon.IO.listModels();
    }
}

function refreshModels() {
    state.models.forEach(m => {
        addon.AlphaModel.load({
            id: m.id,
            path: m.path,
            position: m.position,
            rotation: m.rotation,
            scale: m.scale
        });
    });
}

addon.onInit(async () => {
    Entropy.println("Alpha Preview Addon Initialized");

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

    const tabId = addon.UI.createTab({
        title: "Alpha Preview",
        onRender: () => {
            Entropy.UI.Widget.label(tabId, { text: "🚀 Alpha GPU Renderer", bold: true });

            Entropy.UI.Widget.button(tabId, {
                text: "📂 Import Model & Load into Alpha",
                onClick: async () => {
                    if (addon.IO.pickAndImportModel) {
                        const fileName = await addon.IO.pickAndImportModel();
                        if (fileName && fileName !== "") {
                            await updateAvailableModels();
                            let id = Entropy.generateUUID();
                            const newModel = {
                                id,
                                path: fileName,
                                position: [0, 5, 0],
                                rotation: [0, 0, 0],
                                scale: [1, 1, 1]
                            };
                            state.models.push(newModel);
                            refreshModels();
                        }
                    }
                }
            });

            Entropy.UI.Widget.label(tabId, { text: "--- Models in Project ---", bold: true });
            availableModels.forEach(modelFile => {
                Entropy.UI.Widget.button(tabId, {
                    text: "⚡ Load " + modelFile,
                    onClick: () => {
                        const id = Entropy.generateUUID();
                        const newModel = {
                            id,
                            path: modelFile,
                            position: [0, 5, 0],
                            rotation: [0, 0, 0],
                            scale: [1, 1, 1]
                        };
                        state.models.push(newModel);
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

            Entropy.UI.Widget.label(tabId, { text: "--- Active Alpha Models ---", bold: true });
            state.models.forEach(m => {
                Entropy.UI.Widget.label(tabId, { text: "• " + m.path });
            });

            Entropy.UI.Widget.button(tabId, {
                text: "💾 Save State",
                onClick: () => {
                    addon.IO.save(state);
                    Entropy.println("Alpha Preview state saved");
                }
            });
        }
    });
});
