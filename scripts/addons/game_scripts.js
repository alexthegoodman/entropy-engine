const metadata = {
    name: "Game Scripts",
    version: "1.0.0",
    description: "Manage and edit in-game scripts.",
    author: ["Entropy AI"],
    capabilities: {
        "ui": true,
        "scripts": true
    }
};

const Engine = Entropy.Addon.register(metadata);

let scriptList = [];
let selectedScript = null;
let scriptContent = "";
let isDirty = false;

Engine.onInit(() => {
    println("Game Scripts Addon Initialized");
    refreshScripts();
});

Engine.onProjectChanged(() => {
    refreshScripts();
    selectedScript = null;
    scriptContent = "";
});

function refreshScripts() {
    scriptList = Engine.Scripts.list();
    println("Scripts refreshed: " + scriptList.length);
}

Engine.UI.createTab({
    title: "Script Manager",
    onRender: () => {
        const windowId = "GameScriptsTab";
        
        Entropy.UI.Widget.label(windowId, { text: "Project Scripts", bold: true });
        
        Entropy.UI.Widget.button(windowId, {
            text: "Refresh List",
            onClick: () => {
                refreshScripts();
            }
        });

        Entropy.UI.Widget.button(windowId, {
            text: "New Script",
            onClick: () => {
                const name = "script_" + Math.random().toString(36).substring(2, 8) + ".js";
                const defaultContent = "export function on_update(player, system, state) {
    return state;
}
";
                Engine.Scripts.write(name, defaultContent);
                refreshScripts();
                loadScript(name);
            }
        });

        Entropy.UI.Widget.separator(windowId);

        // List scripts
        scriptList.forEach(script => {
            Entropy.UI.Widget.button(windowId, {
                text: script + (selectedScript === script ? " (Active)" : ""),
                onClick: () => {
                    loadScript(script);
                }
            });
        });

        if (selectedScript) {
            Entropy.UI.Widget.separator(windowId);
            Entropy.UI.Widget.label(windowId, { text: "Editing: " + selectedScript, bold: true });
            
            if (isDirty) {
                Entropy.UI.Widget.label(windowId, { text: "(Modified)", bold: false });
            }

            Entropy.UI.Widget.button(windowId, {
                text: "Save Script",
                onClick: () => {
                    saveScript();
                }
            });

            Entropy.UI.Widget.codeEditor(windowId, {
                label: "Editor",
                content: scriptContent,
                language: "javascript",
                onChange: (newContent) => {
                    scriptContent = newContent;
                    isDirty = true;
                }
            });
        }
    }
});

function loadScript(name) {
    selectedScript = name;
    scriptContent = Engine.Scripts.read(name);
    isDirty = false;
    println("Loaded script: " + name);
}

function saveScript() {
    if (selectedScript) {
        Engine.Scripts.write(selectedScript, scriptContent);
        isDirty = false;
        println("Saved script: " + selectedScript);
    }
}
