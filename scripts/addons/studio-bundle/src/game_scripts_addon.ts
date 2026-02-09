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
        }
    });
});

addon.onProjectChanged(async () => {
    await refreshScripts();
    selectedScript = null;
    scriptContent = "";
    isDirty = false;
});
