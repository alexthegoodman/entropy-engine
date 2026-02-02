const addon = Entropy.Addon.register({
    name: "Game Composer",
    version: "1.0.0",
    description: "Scene composition and Render Role management",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
});

let composerState: any = {
    roles: {
        "Vegetation": "default",
        "Terrain": "default",
        "Sky": "default",
        "Water": "default"
    },
    activeComponentIndex: -1,
    components: [
        { name: "Hair System", addon: "Hair Particles with Ornaments" },
        { name: "Terrain System", addon: "Simple Procedural Terrain" }
    ]
};

const availablePipelines = ["default", "custom_hair_shader_enhanced", "terrain_green", "wireframe"];

addon.onInit(async () => {
    Entropy.println("Game Composer Initializing...");

    const saved = addon.IO.load();
    if (saved) {
        composerState = { ...composerState, ...saved };
    }

    const tab = addon.UI.createTab({
        title: "Game Composer",
        onRender: () => {
             Entropy.UI.Widget.label(tab, { text: "🎬 Game Composer", bold: true });
             
             // === RENDER ROLES ===
             Entropy.UI.Widget.label(tab, { text: "Render Roles (Global Overrides)", bold: true });
             
             Object.keys(composerState.roles).forEach(role => {
                 Entropy.UI.Widget.button(tab, {
                     text: `${role}: ${composerState.roles[role]}`,
                     onClick: () => {
                         // Cycle pipelines
                         const current = composerState.roles[role];
                         const idx = availablePipelines.indexOf(current);
                         const next = availablePipelines[(idx + 1) % availablePipelines.length];
                         composerState.roles[role] = next;
                         
                         // Here we would broadcast this change to relevant components
                         Entropy.println(`Role ${role} switched to ${next}`);
                     }
                 });
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === SCENE GRAPH ===
             Entropy.UI.Widget.label(tab, { text: "Scene Components", bold: true });
             composerState.components.forEach((comp: any, idx: number) => {
                 const isActive = idx === composerState.activeComponentIndex;
                 Entropy.UI.Widget.button(tab, {
                     text: (isActive ? "👉 " : "   ") + comp.name,
                     onClick: () => {
                         composerState.activeComponentIndex = idx;
                     }
                 });
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === INSPECTOR ===
             if (composerState.activeComponentIndex >= 0) {
                 const comp = composerState.components[composerState.activeComponentIndex];
                 Entropy.UI.Widget.label(tab, { text: `Inspector: ${comp.name}`, bold: true });
                 
                 if (Entropy.Composer && Entropy.Composer.getEditor) {
                     const editor = Entropy.Composer.getEditor(comp.addon);
                     if (editor) {
                         // Render the embedded editor!
                         editor(tab);
                     } else {
                         Entropy.UI.Widget.label(tab, { text: "⚠️ No Editor Interface Found" });
                         Entropy.UI.Widget.label(tab, { text: `Make sure '${comp.addon}' is enabled.` });
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
