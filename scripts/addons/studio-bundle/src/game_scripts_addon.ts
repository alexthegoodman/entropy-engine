const addonInfo = {
    name: "Game Scripts",
    version: "1.0.0",
    description: "Manage and edit in-game scripts.",
    author: ["Entropy AI"],
    capabilities: {
        ui: true,
        scripts: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

let scriptList: string[] = [];
let selectedScript: string | null = null;
let scriptContent: string = "";
let isDirty: boolean = false;

interface ScriptComponent {
    id: string;
    name: string;
    scriptName: string;
    modelPath: string;
}

let scriptState: {
    savedComponents: ScriptComponent[];
} = {
    savedComponents: []
};

// Register as a renderer for Game Composer
if (Entropy.Composer) {
    Entropy.Composer.registerRenderer(addonInfo.name, (id, params) => {
        // When a script component is placed, we spawn a model and (theoretically) attach the script.
        // For now, we'll spawn a cube as a placeholder for the scripted object.
        const position = params._transform?.position || [0, 0, 0];
        const rotation = params._transform?.rotation || [0, 0, 0];
        const scale = params._transform?.scale || [1, 1, 1];

        addon.Model.load({
            id: id,
            path: params.modelPath || "Cube.glb",
            position: position,
            rotation: rotation,
            scale: scale
        });

        Entropy.println(`[Game Scripts] Rendering scripted component: ${params.name} with script ${params.scriptName}`);
    });
}

async function refreshScripts() {
    try {
        scriptList = await addon.Scripts.list();
        Entropy.println(`[Game Scripts] Refreshed: ${scriptList.length} scripts found.`);
    } catch (e) {
        Entropy.println(`[Game Scripts] Error refreshing scripts: ${e}`);
    }
}

async function loadScript(name: string) {
    try {
        selectedScript = name;
        scriptContent = await addon.Scripts.read(name);
        isDirty = false;
        Entropy.println(`[Game Scripts] Loaded: ${name}`);
    } catch (e) {
        Entropy.println(`[Game Scripts] Error loading script ${name}: ${e}`);
    }
}

async function saveScript() {
    if (selectedScript) {
        try {
            await addon.Scripts.write(selectedScript, scriptContent);
            isDirty = false;
            Entropy.println(`[Game Scripts] Saved: ${selectedScript}`);
        } catch (e) {
            Entropy.println(`[Game Scripts] Error saving script ${selectedScript}: ${e}`);
        }
    }
}

addon.onInit(async () => {
    Entropy.println("Game Scripts Addon Initializing...");
    await refreshScripts();

    const loadData = () => {
        const saved = addon.IO.load();
        if (saved && saved.savedComponents) {
            scriptState.savedComponents = saved.savedComponents;
            if (Entropy.Composer) {
                scriptState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, {
                        scriptName: comp.scriptName,
                        modelPath: comp.modelPath
                    });
                });
            }
        }
    };

    loadData();

    addon.UI.createTab({
        title: "Script Manager",
        onRender: () => {
            const windowId = "GameScriptsTab";
            
            Entropy.UI.Widget.label(windowId, { text: "📜 Project Scripts", bold: true });
            
            Entropy.UI.Widget.button(windowId, {
                text: "🔄 Refresh List",
                onClick: () => {
                    refreshScripts();
                }
            });

            Entropy.UI.Widget.button(windowId, {
                text: "➕ New Script",
                onClick: async () => {
                    const name = "script_" + Math.random().toString(36).substring(2, 8) + ".js";
                    const defaultContent = `export function on_update(player, system, state) {
    return state;
}
`;
                    await addon.Scripts.write(name, defaultContent);
                    await refreshScripts();
                    await loadScript(name);
                }
            });

            Entropy.UI.Widget.separator(windowId);

            // List scripts
            scriptList.forEach(script => {
                const isActive = selectedScript === script;
                Entropy.UI.Widget.button(windowId, {
                    text: (isActive ? "▶ " : "  ") + script,
                    onClick: () => {
                        loadScript(script);
                    }
                });
            });

            if (selectedScript) {
                Entropy.UI.Widget.separator(windowId);
                Entropy.UI.Widget.label(windowId, { text: `Editing: ${selectedScript}`, bold: true });
                
                if (isDirty) {
                    Entropy.UI.Widget.label(windowId, { text: "⚠️ Unsaved Changes", bold: false });
                }

                Entropy.UI.Widget.button(windowId, {
                    text: "💾 Save Script",
                    onClick: () => {
                        saveScript();
                    }
                });

                Entropy.UI.Widget.button(windowId, {
                    text: "📦 Save as Component",
                    onClick: () => {
                        const name = "My Scripted Object";
                        if (name) {
                            const id = Entropy.generateUUID();
                            const newComp: ScriptComponent = {
                                id,
                                name,
                                scriptName: selectedScript!,
                                modelPath: "Cube.glb" // default
                            };
                            scriptState.savedComponents.push(newComp);
                            if (Entropy.Composer) {
                                Entropy.Composer.registerComponent(addonInfo.name, id, name, {
                                    scriptName: newComp.scriptName,
                                    modelPath: newComp.modelPath
                                });
                            }
                            addon.IO.save(scriptState);
                            Entropy.println(`[Game Scripts] Saved component: ${name}`);
                        }
                    }
                });

                Entropy.UI.Widget.codeEditor(windowId, {
                    label: "Editor",
                    content: scriptContent,
                    language: "javascript",
                    onChange: (newContent: string) => {
                        scriptContent = newContent;
                        isDirty = true;
                    }
                });
            }

            if (scriptState.savedComponents.length > 0) {
                Entropy.UI.Widget.separator(windowId);
                Entropy.UI.Widget.label(windowId, { text: "📦 Saved Script Components", bold: true });
                scriptState.savedComponents.forEach(comp => {
                    Entropy.UI.Widget.label(windowId, { text: `${comp.name} (${comp.scriptName})` });
                });
            }
        }
    });

    // --- Tools Registration ---

    addon.registerTool({
        name: "list_script_components",
        description: "List all saved script components available for the Game Composer.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return { success: true, components: scriptState.savedComponents };
    });

    addon.registerTool({
        name: "create_script_component",
        description: "Create a new script component that can be placed in the scene.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name for the component." },
                scriptName: { type: "string", description: "The .js file to use." },
                modelPath: { type: "string", description: "Optional .glb model path." }
            },
            required: ["name", "scriptName"]
        }
    }, (args: any) => {
        const id = Entropy.generateUUID();
        const newComp: ScriptComponent = {
            id,
            name: args.name,
            scriptName: args.scriptName,
            modelPath: args.modelPath || "Cube.glb"
        };
        scriptState.savedComponents.push(newComp);
        if (Entropy.Composer) {
            Entropy.Composer.registerComponent(addonInfo.name, id, args.name, {
                scriptName: newComp.scriptName,
                modelPath: newComp.modelPath
            });
        }
        addon.IO.save(scriptState);
        return { success: true, id };
    });
});

addon.onProjectChanged(async () => {
    await refreshScripts();
    selectedScript = null;
    scriptContent = "";
    isDirty = false;
    
    const saved = addon.IO.load();
    if (saved && saved.savedComponents) {
        scriptState.savedComponents = saved.savedComponents;
        if (Entropy.Composer) {
            scriptState.savedComponents.forEach(comp => {
                Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, {
                    scriptName: comp.scriptName,
                    modelPath: comp.modelPath
                });
            });
        }
    }
});
