const addon = Entropy.Addon.register({
    name: "Game Composer",
    version: "1.1.0",
    description: "Advanced Scene Composition and Render Role management",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
});

interface ComponentInstance {
    id: string;
    name: string;
    addon: string;
    projectId: string; // The project ID in that addon
    position: [number, number, number];
    scale: [number, number, number];
    visible: boolean;
}

let composerState: {
    roles: Record<string, string>;
    activeComponentId: string | null;
    components: ComponentInstance[];
} = {
    roles: {
        "Vegetation": "default",
        "Terrain": "default",
        "Sky": "default",
        "Water": "default",
        "Lighting": "default"
    },
    activeComponentId: null,
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

const availableAddons = [
    { name: "Hair Particles with Ornaments", defaultName: "Grass System" },
    { name: "Simple Procedural Terrain", defaultName: "Rust Terrain" },
    { name: "Procedural Terrain", defaultName: "JS Terrain" },
    { name: "Environment", defaultName: "Atmosphere" },
    { name: "WaterPlaneAddon", defaultName: "Ocean" },
    { name: "Lighting Demo", defaultName: "Dynamic Lights" }
];

addon.onInit(async () => {
    Entropy.println("Game Composer Initializing...");

    addon.onProjectChanged((newProjectId) => {
        Entropy.println("Project changed: " + newProjectId);

        activeProjectId = newProjectId;

        const saved = addon.IO.load();
        if (saved) {
            composerState = { ...composerState, ...saved };
        }

        Entropy.println("ReLoaded game composer settings");
    });

    const tab = addon.UI.createTab({
        title: "Game Composer",
        onRender: () => {
             Entropy.UI.Widget.label(tab, { text: "🎬 Game Composer", bold: true });
             Entropy.UI.Widget.label(tab, { text: "Welcome! Use this tool to assemble your scene by combining" });
             Entropy.UI.Widget.label(tab, { text: "components from different addons and managing global render styles." });
             Entropy.UI.Widget.label(tab, { text: "" });

             // === RENDER ROLES ===
             Entropy.UI.Widget.label(tab, { text: "🎭 Render Roles", bold: true });
             Entropy.UI.Widget.label(tab, { text: "Assign global pipelines to specific roles. All objects tagged with" });
             Entropy.UI.Widget.label(tab, { text: "a role will use the selected pipeline regardless of their origin." });
             
             Object.keys(composerState.roles).forEach(role => {
                 const current = composerState.roles[role];
                 const selectedIndex = availablePipelines.indexOf(current);
                 
                 Entropy.UI.Widget.dropdown(tab, {
                     label: role,
                     options: availablePipelines,
                     selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
                     onChange: (indexStr: string) => {
                         const idx = parseInt(indexStr);
                         const next = availablePipelines[idx];
                         composerState.roles[role] = next;
                         
                         if (Entropy.Composer && Entropy.Composer.setRolePipeline) {
                             Entropy.Composer.setRolePipeline(role, next);
                         }
                         
                         Entropy.println(`Role ${role} switched to ${next}`);
                     }
                 });
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === SCENE GRAPH ===
             Entropy.UI.Widget.label(tab, { text: "📦 Scene Components", bold: true });
             Entropy.UI.Widget.label(tab, { text: "Add and manage instances of your enabled addons." });
             
             composerState.components.forEach((comp) => {
                 const isActive = comp.id === composerState.activeComponentId;
                 Entropy.UI.Widget.button(tab, {
                     text: (isActive ? "👉 " : "   ") + comp.name + (comp.visible ? "" : " (Hidden)"),
                     onClick: () => {
                         composerState.activeComponentId = comp.id;
                     }
                 });
             });

             Entropy.UI.Widget.button(tab, {
                 text: "➕ Add Component",
                 onClick: () => {
                     // In a real app we'd show a menu. Here we'll cycle through available addons.
                     const nextAddon = availableAddons[composerState.components.length % availableAddons.length];
                     const newComp: ComponentInstance = {
                         id: Math.random().toString(36).substr(2, 9),
                         name: nextAddon.defaultName + " " + (composerState.components.length + 1),
                         addon: nextAddon.name,
                         projectId: "default", // or current project id
                         position: [0, 0, 0],
                         scale: [1, 1, 1],
                         visible: true
                     };
                     composerState.components.push(newComp);
                     composerState.activeComponentId = newComp.id;
                 }
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === INSPECTOR ===
             const activeComp = composerState.components.find(c => c.id === composerState.activeComponentId);
             
             if (activeComp) {
                 Entropy.UI.Widget.label(tab, { text: `🔍 Inspector: ${activeComp.name}`, bold: true });
                 Entropy.UI.Widget.label(tab, { text: "Edit local properties and access the full addon interface below." });
                 Entropy.UI.Widget.label(tab, { text: `Addon Source: ${activeComp.addon}` });
                 
                 Entropy.UI.Widget.button(tab, {
                     text: activeComp.visible ? "👁️ Visible" : "🌑 Hidden",
                     onClick: () => { activeComp.visible = !activeComp.visible; }
                 });

                 Entropy.UI.Widget.button(tab, {
                    text: "🗑️ Delete Component",
                    onClick: () => {
                        composerState.components = composerState.components.filter(c => c.id !== activeComp.id);
                        composerState.activeComponentId = null;
                    }
                 });

                 Entropy.UI.Widget.label(tab, { text: "Generic Properties", bold: true });
                 // Note: Slider/NumericInput for Vec3 would be better, but we use what we have
                 Entropy.UI.Widget.label(tab, { text: `Position: [${activeComp.position.join(", ")}]` });

                 Entropy.UI.Widget.label(tab, { text: "--- Addon Properties ---", bold: true });
                 
                 if (Entropy.Composer && Entropy.Composer.getEditor) {
                     const editor = Entropy.Composer.getEditor(activeComp.addon);
                     if (editor) {
                         // Render the embedded editor from the other addon!
                         editor(tab);
                     } else {
                         Entropy.UI.Widget.label(tab, { text: "⚠️ No Editor Interface Found" });
                         Entropy.UI.Widget.label(tab, { text: `Make sure '${activeComp.addon}' is enabled.` });
                     }
                 }
             } else {
                 Entropy.UI.Widget.label(tab, { text: "Select a component to edit properties." });
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

