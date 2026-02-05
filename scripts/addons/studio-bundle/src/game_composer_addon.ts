const addonInfo = {
    name: "Game Composer",
    version: "2.0.0",
    description: "Advanced Scene Composition and Component management",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

interface ComponentInstance {
    id: string;
    name: string;
    addon: string;
    componentId: string; // The ID from the addon's registry
    params?: any; // Deprecated: params are stored in each addons own file. We now fetch them dynamically.
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
    "FFT Ocean",
    "FlexNoise Terrain",
    "Hair Particles with Ornaments",
    "PBR Texture Designer Pro",
    "Light Hive",
    "Advanced Water Plane" // Legacy
];

function refreshScene() {
    // Use context override so everything spawned belongs to "Game Composer" bucket in Rust
    (globalThis as any).__entropy_current_addon_context_override = "Game Composer";
    
    // Clear existing meshes owned by Game Composer (implicit in how Addons work usually, 
    // but if we want to be safe we might need a clear command. 
    // For now, re-running renderers usually overwrites if IDs match).
    
    composerState.components.forEach(inst => {
        if (inst.visible) {
            const renderer = Entropy.Composer?.getRenderer(inst.addon);
            
            // Fetch the latest params from the source addon
            const components = Entropy.Composer?.getComponents(inst.addon) || {};
            const sourceParams = components[inst.componentId]?.params;
            
            // Fallback to inst.params if source is missing (legacy support), or {}
            const paramsToUse = sourceParams || inst.params || {};

            if (renderer) {
                // Pass transform data so the renderer can position the mesh
                const renderParams = { 
                    ...paramsToUse, 
                    _transform: { 
                        position: inst.position, 
                        scale: inst.scale 
                    } 
                };

                Entropy.println("Game Composer render ... " + JSON.stringify(renderParams));

                renderer(inst.id, renderParams);
            }
        }
    });

    (globalThis as any).__entropy_current_addon_context_override = null;
}

addon.onInit(async () => {
    Entropy.println("Game Composer 2.0 Initializing...");

    // Atmospheric lighting
    addon.Lighting.createPointLight({
        position: [-3.0, 4.0, 65.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 150.0
    });

    addon.Lighting.createPointLight({
        position: [3.0, 4.0, 10.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 150.0
    });

    addon.Lighting.createPointLight({
        position: [0.0, 5.0, -60.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 150.0
    });

    addon.onProjectChanged((id) => {
        const data = addon.IO.load();
        if (data) {
            composerState = { ...composerState, ...data };
            refreshScene(); // until we clear, lets avoid this?

            if (Entropy.Composer && typeof Entropy.Composer.initCallbacks[addonInfo.name] === "function") {
                Entropy.Composer.initCallbacks[addonInfo.name]();
            }
        }
    });

    const tab = addon.UI.createTab({
        title: "Game Composer",
        onRender: () => {
             // Hide other addons' internal outputs when viewing the composer
             sourceAddons.forEach(name => {
                 Entropy.Addon.setVisibility(name, false);
             });
             // Always show our own managed components
             Entropy.Addon.setVisibility("Game Composer", true);

            if (Entropy.Composer) {
                const lightUI = Entropy.Composer.getEditor("Light Hive");
                if (lightUI) {
                    lightUI(tab); // Renders the light hive controls here!
                }
            }

             Entropy.UI.Widget.label(tab, { text: "🎬 Game Composer", bold: true });
             
             // === TOOLBAR ===
             Entropy.UI.Widget.button(tab, {
                 text: "💾 Save Scene",
                 onClick: () => {
                     // Clean up params from components before saving
                     const cleanState = {
                         ...composerState,
                         components: composerState.components.map(c => {
                             // Explicitly destructure to remove params, even if undefined
                             const { params, ...rest } = c;
                             return rest;
                         })
                     };
                     addon.IO.save(cleanState);
                     Entropy.println("Composition saved!");
                 }
             });
             
             Entropy.UI.Widget.button(tab, {
                 text: "🔄 Refresh Scene",
                 onClick: () => refreshScene()
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === COMPONENT LIBRARY ===
             Entropy.UI.Widget.label(tab, { text: "📚 Component Library", bold: true });
             
             let hasComponents = false;
             sourceAddons.forEach(addonName => {
                 const components = Entropy.Composer?.getComponents(addonName) || {};
                 const ids = Object.keys(components);
                 if (ids.length > 0) {
                     hasComponents = true;
                     Entropy.UI.Widget.label(tab, { text: `▶ ${addonName}` }); // Group Header
                     ids.forEach(compId => {
                         const comp = components[compId];
                         Entropy.UI.Widget.button(tab, {
                             text: `  ➕ ${comp.name}`,
                             onClick: () => {
                                 const newInst: ComponentInstance = {
                                     id: Entropy.generateUUID(),
                                     name: `${comp.name} Instance`,
                                     addon: addonName,
                                     componentId: compId,
                                     // params: JSON.parse(JSON.stringify(comp.params)), // REMOVED: We don't store params anymore
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
             
             if (!hasComponents) {
                 Entropy.UI.Widget.label(tab, { text: "No components found. Create them in other addons first!" });
             }

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === SCENE GRAPH ===
             Entropy.UI.Widget.label(tab, { text: "📦 Scene Hierarchy", bold: true });
             if (composerState.components.length === 0) {
                 Entropy.UI.Widget.label(tab, { text: "(Empty Scene)" });
             }
             
             composerState.components.forEach((inst) => {
                 const isActive = inst.id === composerState.activeInstanceId;
                 Entropy.UI.Widget.button(tab, {
                     text: (isActive ? "🔵 " : "⚪ ") + inst.name + (inst.visible ? "" : " (Hidden)"),
                     onClick: () => {
                         composerState.activeInstanceId = inst.id;
                     }
                 });
             });

             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

             // === INSPECTOR ===
             const activeInst = composerState.components.find(c => c.id === composerState.activeInstanceId);
             if (activeInst) {
                 Entropy.UI.Widget.label(tab, { text: `🔍 Inspector: ${activeInst.name}`, bold: true });
                 
                 // Visibility & Delete
                 Entropy.UI.Widget.button(tab, {
                     text: activeInst.visible ? "👁️ Visible" : "🌑 Hidden",
                     onClick: () => { 
                         activeInst.visible = !activeInst.visible; 
                         refreshScene();
                     }
                 });

                 Entropy.UI.Widget.button(tab, {
                    text: "🗑️ Delete Object",
                    onClick: () => {
                        composerState.components = composerState.components.filter(c => c.id !== activeInst.id);
                        composerState.activeInstanceId = null;
                        refreshScene();
                    }
                 });
                 
                 // Transform
                 Entropy.UI.Widget.label(tab, { text: "📐 Transform", bold: true });
                 
                 // Position
                 Entropy.UI.Widget.label(tab, { text: "Position" });
                 Entropy.UI.Widget.slider(tab, { label: "X", value: activeInst.position[0], min: -500, max: 500, onChange: (v) => { activeInst.position[0] = parseFloat(v); refreshScene(); } });
                 Entropy.UI.Widget.slider(tab, { label: "Y", value: activeInst.position[1], min: -100, max: 500, onChange: (v) => { activeInst.position[1] = parseFloat(v); refreshScene(); } });
                 Entropy.UI.Widget.slider(tab, { label: "Z", value: activeInst.position[2], min: -500, max: 500, onChange: (v) => { activeInst.position[2] = parseFloat(v); refreshScene(); } });

                 // Scale
                 Entropy.UI.Widget.label(tab, { text: "Scale" });
                 Entropy.UI.Widget.slider(tab, { label: "Uniform", value: activeInst.scale[0], min: 0.1, max: 10, onChange: (v) => { 
                     const s = parseFloat(v); activeInst.scale = [s, s, s]; refreshScene(); 
                 }});
                 
                 Entropy.UI.Widget.label(tab, { text: "--- Properties ---", bold: true });
                 const editor = Entropy.Composer?.getEditor(activeInst.addon);
                 if (editor) {
                    editor(tab);
                 }
             } else {
                 Entropy.UI.Widget.label(tab, { text: "Select an object to inspect." });
             }
             
             Entropy.UI.Widget.label(tab, { text: "--------------------------------" });
             
             // === RENDER ROLES ===
             Entropy.UI.Widget.label(tab, { text: "🎭 Render Roles (Global)", bold: true });
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
        }
    });
});