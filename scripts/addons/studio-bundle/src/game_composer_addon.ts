const addon = Entropy.Addon.register({
    name: "Game Composer",
    version: "1.2.0",
    description: "Advanced Scene Composition and Component management",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
});

interface ComponentInstance {
    id: string;
    name: string;
    addon: string;
    componentId: string; // The ID from the addon's registry
    params: any; // Cached params for rendering
    position: [number, number, number];
    scale: [number, number, number];
    visible: boolean;
}

let composerState: {
    roles: Record<string, string>;
    activeInstanceId: string | null;
    components: ComponentInstance[];
} = {
    roles: {
        "Vegetation": "default",
        "Terrain": "default",
        "Sky": "default",
        "Water": "default",
        "Lighting": "default"
    },
    activeInstanceId: null,
    components: []
};

let activeProjectId: string | null = null;

const availablePipelines = [
    "default", 
    "custom_hair_shader_enhanced", 
    "terrain_green", 
    "environment_lighting", 
    "WaterPipeline",
    "wireframe"
];

const sourceAddons = [
    "Hair Particles with Ornaments",
    "FlexNoise Terrain",
    "Advanced Water Plane",
    "PBR Texture Designer Pro"
];

function refreshScene() {
    Entropy.println("Refreshing Composer scene...");
    composerState.components.forEach(inst => {
        if (inst.visible) {
            const renderer = Entropy.Composer?.getRenderer(inst.addon);
            if (renderer) {
                // We might want to merge inst.position into inst.params here
                // For now, addons handle their own positions in params
                renderer(inst.id, inst.params);
            }
        }
    });
}

addon.onInit(async () => {
    Entropy.println("Game Composer Initializing...");

    addon.onProjectChanged((newProjectId) => {
        Entropy.println("Project changed: " + newProjectId);
        activeProjectId = newProjectId;
        const saved = addon.IO.load();
        if (saved) {
            composerState = { ...composerState, ...saved };
            // Need a delay to let other addons register? 
            // Or just refresh whenever possible.
            setTimeout(() => refreshScene(), 1000);
        }
    });

    const tab = addon.UI.createTab({
        title: "Game Composer",
        onRender: () => {
             Entropy.UI.Widget.label(tab, { text: "🎬 Game Composer", bold: true });
             
             // === RENDER ROLES ===
             Entropy.UI.Widget.label(tab, { text: "🎭 Render Roles", bold: true });
             Object.keys(composerState.roles).forEach(role => {
                 const current = composerState.roles[role];
                 Entropy.UI.Widget.dropdown(tab, {
                     label: role,
                     options: availablePipelines,
                     selectedIndex: availablePipelines.indexOf(current) || 0,
                     onChange: (indexStr: string) => {
                         const next = availablePipelines[parseInt(indexStr)];
                         composerState.roles[role] = next;
                         Entropy.Composer?.setRolePipeline(role, next);
                     }
                 });
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === COMPONENT LIBRARY ===
             Entropy.UI.Widget.label(tab, { text: "📚 Component Library", bold: true });
             sourceAddons.forEach(addonName => {
                 const components = Entropy.Composer?.getComponents(addonName) || {};
                 const ids = Object.keys(components);
                 if (ids.length > 0) {
                     Entropy.UI.Widget.label(tab, { text: `From ${addonName}:` });
                     ids.forEach(compId => {
                         const comp = components[compId];
                         Entropy.UI.Widget.button(tab, {
                             text: `➕ Add ${comp.name}`,
                             onClick: () => {
                                 const newInst: ComponentInstance = {
                                     id: Math.random().toString(36).substr(2, 9),
                                     name: comp.name,
                                     addon: addonName,
                                     componentId: compId,
                                     params: comp.params,
                                     position: [0, 0, 0],
                                     scale: [1, 1, 1],
                                     visible: true
                                 };
                                 composerState.components.push(newInst);
                                 composerState.activeInstanceId = newInst.id;
                                 refreshScene();
                             }
                         });
                     });
                 }
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === SCENE GRAPH ===
             Entropy.UI.Widget.label(tab, { text: "📦 Active Scene Components", bold: true });
             composerState.components.forEach((inst) => {
                 const isActive = inst.id === composerState.activeInstanceId;
                 Entropy.UI.Widget.button(tab, {
                     text: (isActive ? "👉 " : "   ") + inst.name + (inst.visible ? "" : " (Hidden)"),
                     onClick: () => {
                         composerState.activeInstanceId = inst.id;
                     }
                 });
             });

             Entropy.UI.Widget.button(tab, {
                 text: "🔄 Refresh Scene",
                 onClick: () => refreshScene()
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === INSPECTOR ===
             const activeInst = composerState.components.find(c => c.id === composerState.activeInstanceId);
             if (activeInst) {
                 Entropy.UI.Widget.label(tab, { text: `🔍 Inspector: ${activeInst.name}`, bold: true });
                 
                 Entropy.UI.Widget.button(tab, {
                     text: activeInst.visible ? "👁️ Visible" : "🌑 Hidden",
                     onClick: () => { 
                         activeInst.visible = !activeInst.visible; 
                         refreshScene();
                     }
                 });

                 Entropy.UI.Widget.button(tab, {
                    text: "🗑️ Remove Instance",
                    onClick: () => {
                        composerState.components = composerState.components.filter(c => c.id !== activeInst.id);
                        composerState.activeInstanceId = null;
                        refreshScene();
                    }
                 });

                 Entropy.UI.Widget.label(tab, { text: "--- Deep Edit ---", bold: true });
                 const editor = Entropy.Composer?.getEditor(activeInst.addon);
                 if (editor) {
                     // Note: The addon editor will edit its OWN currentParams.
                     // We might need to sync them back to the instance!
                     editor(tab);
                 }
             } else {
                 Entropy.UI.Widget.label(tab, { text: "Select an instance to edit." });
             }
             
             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === PERSISTENCE ===
             Entropy.UI.Widget.button(tab, {
                 text: "💾 Save Composition",
                 onClick: () => {
                     addon.IO.save(composerState);
                     Entropy.println("Composition saved!");
                 }
             });
        }
    });
});