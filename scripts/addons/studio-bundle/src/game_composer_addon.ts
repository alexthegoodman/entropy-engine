import type { GlobalSettings } from "./addon";

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
    playMode: boolean;
    globalSettings?: GlobalSettings
} = {
    roles: {
        "Vegetation": "default",
        "Terrain": "default",
        "Sky": "default",
        "Water": "default",
        "Lighting": "default"
    },
    activeInstanceId: null,
    components: [],
    playMode: false,
    globalSettings: {
        landscapeSettings: {
            size: 4096,
            height: 600,
            yOffset: -500
        }
    }
};

let activeProjectId: string | null = null;

let sectionsOpen = {
    hierarchy: false,
    inspector: false,
    library: false,
    addEntity: false
};

const availablePipelines = [
    "default", 
    "custom_hair_shader_enhanced", 
    "terrain_green", 
    "environment_lighting", 
    "WaterPipeline",
    "wireframe"
];

// TODO: make this dynamic
const sourceAddons = [
    "FFT Ocean",
    "FFT River Water", 
    "FlexNoise Terrain",
    "Hair Particles with Ornaments",
    "PBR Texture Designer Pro",
    "Light Hive",
    "Model Viewer",
    "GPGPU River Simulation"
];

const gameAddons = [
    "The Fractured Realm"
];

function refreshScene() {
    // Use context override so everything spawned belongs to "Game Composer" bucket in Rust
    // (globalThis as any).__entropy_current_addon_context_override = "Game Composer";
    Entropy.Composer?.enableGameComposerOverride();
    
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

    // (globalThis as any).__entropy_current_addon_context_override = null;
    Entropy.Composer?.disableGameComposerOverride();
}

// runs after all projects are loaded in non-composer addons
addon.onAllProjectsLoaded(() => {
    Entropy.println("[Game Composer] All projects loaded...");

    const data = addon.IO.load();
    if (data) {
        composerState = { ...composerState, ...data };

        if (composerState.globalSettings) {
            Entropy.Composer?.setGlobalSettings(composerState.globalSettings);
        }

        refreshScene(); // until we clear, lets avoid this?
    }
});

addon.onInit(async () => {
    Entropy.println("Game Composer 2.0 Initializing...");

    // Atmospheric lighting
    addon.Lighting.createPointLight({
        position: [-3.0, 4.0, 65.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    addon.Lighting.createPointLight({
        position: [3.0, 4.0, 10.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    addon.Lighting.createPointLight({
        position: [0.0, 5.0, -60.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    // addon.onProjectChanged((id) => {
    //     const data = addon.IO.load();
    //     if (data) {
    //         composerState = { ...composerState, ...data };
    //         refreshScene(); // until we clear, lets avoid this?
    //     }
    // });

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
                    // ensure the spawned lights show in Game Composer (need a better API for this, maybe getEditor should autooverride)
                    lightUI(tab, "Game Composer"); // Renders the light hive controls here!
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

             Entropy.UI.Widget.button(tab, {
                 text: composerState.playMode ? "⏹ Stop Game" : "▶ Play Game",
                 onClick: () => {
                    Entropy.println("Updating game status...");

                    composerState.playMode = !composerState.playMode;
                    Entropy.setGameMode(composerState.playMode);
                    
                    if (composerState.playMode) {
                        Entropy._dispatchGameStarted();
                        Entropy.println("Game started!");
                    } else {
                        Entropy._dispatchGameStopped();
                        Entropy.println("Game stopped!");
                    }
                 }
             });

             // in liue of a register system dedicated to the composer
            // actually, registerGame, then let the user seslect one to restore, bingo
            gameAddons.forEach((addon) => {
                Entropy.UI.Widget.button(tab, {
                    text: "🔄 Add Game: " + addon,
                    onClick: () => {    
                        (globalThis as any).__entropy_current_addon_context_override = "Game Composer";

                        Entropy.println("Adding game: " + addon);

                        const renderer = Entropy.Composer?.getGame(addon);

                        if (renderer) {
                            Entropy.println("Game Composer Game render ... ");
                            renderer(addon, {});
                        }

                        (globalThis as any).__entropy_current_addon_context_override = null;
                    }
                });
            });

             Entropy.UI.Widget.separator(tab);

             // === ADD ENTITY ===
             Entropy.UI.Widget.button(tab, {
                 text: (sectionsOpen.addEntity ? "▼ " : "▶ ") + "Add Entity",
                 onClick: () => { sectionsOpen.addEntity = !sectionsOpen.addEntity; }
             });

             if (sectionsOpen.addEntity) {
                 if (Entropy.Composer && Entropy.Composer.editors) {
                     Object.keys(Entropy.Composer.editors).forEach(addonName => {
                         Entropy.UI.Widget.collapsingHeader(tab, addonName, (headerTab) => {
                             const renderFn = Entropy.Composer!.editors[addonName];
                             if (renderFn) {
                                 renderFn(headerTab, "Game Composer");
                             }
                         });
                     });
                 }
             }

             Entropy.UI.Widget.separator(tab);

             // === SCENE GRAPH ===
             Entropy.UI.Widget.button(tab, {
                 text: (sectionsOpen.hierarchy ? "▼ " : "▶ ") + "Scene Hierarchy",
                 onClick: () => { sectionsOpen.hierarchy = !sectionsOpen.hierarchy; }
             });

             if (sectionsOpen.hierarchy) {
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
             }

             Entropy.UI.Widget.separator(tab);

             // === INSPECTOR ===
             Entropy.UI.Widget.button(tab, {
                 text: (sectionsOpen.inspector ? "▼ " : "▶ ") + "Inspector",
                 onClick: () => { sectionsOpen.inspector = !sectionsOpen.inspector; }
             });

             if (sectionsOpen.inspector) {
                 const activeInst = composerState.components.find(c => c.id === composerState.activeInstanceId);
                 if (activeInst) {
                     Entropy.UI.Widget.label(tab, { text: `Selected: ${activeInst.name}`, bold: true });
                     
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
                        editor(tab, "Game Composer");
                     }
                 } else {
                     Entropy.UI.Widget.label(tab, { text: "Select an object to inspect." });
                 }
             }

            Entropy.UI.Widget.separator(tab);

             // === COMPONENT LIBRARY ===
             Entropy.UI.Widget.button(tab, {
                 text: (sectionsOpen.library ? "▼ " : "▶ ") + "Component Library",
                 onClick: () => { sectionsOpen.library = !sectionsOpen.library; }
             });

             if (sectionsOpen.library) {
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
             }
        }
    });

    // --- Tools Registration ---

    addon.registerTool({
        name: "list_scene_objects",
        description: "List all object instances currently in the scene managed by the Game Composer.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return { success: true, objects: composerState.components };
    });

    addon.registerTool({
        name: "add_to_scene",
        description: "Add a specific component (e.g., a specific Terrain or NPC) to the scene. The y position will auto-set to the terrain height.",
        parameters: {
            type: "object",
            properties: {
                addonName: { type: "string", description: "The addon the component belongs to (e.g., 'FlexNoise Terrain')." },
                componentId: { type: "string", description: "The ID of the saved component from that addon." },
                name: { type: "string", description: "A friendly name for this instance." },
                position: { type: "array", items: { type: "number" } },
                scale: { type: "array", items: { type: "number" } }
            },
            required: ["addonName", "componentId"]
        }
    }, (args: any) => {
        Entropy.println("Adding component to scene via tool: " + args.componentId);
        const y = addon.Landscape.getHeightAt(args.position[0], args.position[2]);
        const newInst: ComponentInstance = {
            id: Entropy.generateUUID(),
            name: args.name || `${args.componentId} Instance`,
            addon: args.addonName,
            componentId: args.componentId,
            position: [args.position[0] || 0, y || 0, args.position[2] || 0],
            scale: args.scale || [1, 1, 1],
            visible: true
        };
        composerState.components.push(newInst);
        composerState.activeInstanceId = newInst.id;
        refreshScene();
        return { success: true, id: newInst.id };
    });

    addon.registerTool({
        name: "update_scene_object",
        description: "Update the transform or visibility of an object in the scene.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "The instance ID of the object." },
                position: { type: "array", items: { type: "number" } },
                scale: { type: "array", items: { type: "number" } },
                visible: { type: "boolean" }
            },
            required: ["id"]
        }
    }, (args: any) => {
        const inst = composerState.components.find(c => c.id === args.id);
        if (!inst) return { success: false, error: "Object not found." };

        if (args.position) inst.position = args.position;
        if (args.scale) inst.scale = args.scale;
        if (typeof args.visible !== "undefined") inst.visible = args.visible;

        refreshScene();
        return { success: true };
    });

    addon.registerTool({
        name: "remove_from_scene",
        description: "Remove an object instance from the scene.",
        parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"]
        }
    }, (args: any) => {
        composerState.components = composerState.components.filter(c => c.id !== args.id);
        if (composerState.activeInstanceId === args.id) composerState.activeInstanceId = null;
        refreshScene();
        return { success: true };
    });
});