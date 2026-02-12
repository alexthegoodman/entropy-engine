// Light Hive Addon
// Manages collections of point lights that can be placed in the scene

const addonInfo = {
    name: "Light Hive",
    version: "1.0.0",
    description: "Point Light Management System",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

interface LightParams {
    color: [number, number, number];
    intensity: number;
    maxDistance: number;
}

let lightState = {
    savedComponents: [
        { 
            id: "basic_light", 
            name: "Basic Point Light", 
            params: {
                color: [1.0, 1.0, 1.0],
                intensity: 5.0,
                maxDistance: 50.0
            } as LightParams
        }
    ],
    activeComponentId: "basic_light",
    get currentParams(): LightParams {
        const found = this.savedComponents.find(c => c.id === this.activeComponentId);
        return found ? found.params : this.savedComponents[0].params;
    }
};

// Track camera position for "Spawn at Camera"
let lastCameraTransform = { pos: [0, 0, 0], dir: [0, 0, -1] };

// Renderer implementation
function renderLight(id: string, params: LightParams & { _transform?: { position: [number, number, number] } }) {
    const position = params._transform?.position || [0, 0, 0];

    const config = {
        position: position,
        color: params.color,
        intensity: params.intensity,
        maxDistance: params.maxDistance
    };

    Entropy.println("createPointLight: " + JSON.stringify(config));
    
    addon.Lighting.createPointLight(config);
}

function refreshPreview() {
    // Only spawn the preview if we aren't being called through the Game Composer
    // (We use a fixed ID "preview_light" if the engine supports it, 
    // but for now we just spawn it once per change).
    renderLight("preview_light", {
        ...lightState.currentParams,
        _transform: { position: [0, 5, 0] }
    });
}

const renderLightUI = (tab: string) => {
    Entropy.UI.Widget.label(tab, { text: "💡 Light Properties", bold: true });
    
    Entropy.UI.Widget.colorInput(tab, {
        label: "Color",
        color: [...lightState.currentParams.color, 1.0] as [number, number, number, number],
        onChange: (col: number[]) => {
            lightState.currentParams.color = [col[0], col[1], col[2]];
            refreshPreview();
        }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Intensity",
        value: lightState.currentParams.intensity,
        min: 0,
        max: 50,
        onChange: (v: string) => {
            lightState.currentParams.intensity = parseFloat(v);
            refreshPreview();
        }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Max Distance",
        value: lightState.currentParams.maxDistance,
        min: 1,
        max: 500,
        onChange: (v: string) => {
            lightState.currentParams.maxDistance = parseFloat(v);
            refreshPreview();
        }
    });

    Entropy.UI.Widget.label(tab, { text: "--------------------------------" });
    
    Entropy.UI.Widget.button(tab, {
        text: "✨ Spawn at Camera",
        onClick: () => {
            const pos = lastCameraTransform.pos;
            const dir = lastCameraTransform.dir;
            
            // Spawn 2 units in front of the camera
            const spawnPos: [number, number, number] = [
                pos[0] + dir[0] * 2,
                pos[1] + dir[1] * 2,
                pos[2] + dir[2] * 2
            ];
            
            renderLight(Entropy.generateUUID(), {
                ...lightState.currentParams,
                _transform: { position: spawnPos }
            });
            
            Entropy.println(`Spawned light at camera: ${spawnPos}`);
        }
    });

    Entropy.UI.Widget.button(tab, {
        text: "💾 Save Light Preset",
        onClick: () => {
            const id = Entropy.generateUUID();
            const name = `Light ${lightState.savedComponents.length + 1}`;
            const newComp = {
                id,
                name,
                params: JSON.parse(JSON.stringify(lightState.currentParams))
            };
            lightState.savedComponents.push(newComp);
            
            if (Entropy.Composer) {
                Entropy.Composer.registerComponent(addonInfo.name, id, name, newComp.params);
            }
            addon.IO.save(lightState);
            Entropy.println(`Saved light preset: ${name}`);
        }
    });
};

addon.onInit(async () => {
    Entropy.println("Light Hive Initializing...");

    // Load saved state
    // const saved = addon.IO.load();
    // if (saved) {
    //     lightState = { ...lightState, ...saved };
    //     if (Entropy.Composer) {
    //         lightState.savedComponents.forEach(comp => {
    //             Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
    //         });
    //     }
    // }

    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            if (data.savedComponents) lightState.savedComponents = data.savedComponents;
            if (data.activeComponentId) lightState.activeComponentId = data.activeComponentId;

            // Register components with the composer
            if (Entropy.Composer) {
                lightState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                });
            }
        }
    });

    // Camera tracking and stable update loop
    addon.onUpdate((time: number, pos: [number, number, number], dir: [number, number, number]) => {
        lastCameraTransform.pos = pos;
        lastCameraTransform.dir = dir;
        
        // We no longer spawn every frame! 
        // refreshPreview() is now event-driven.
    });

    // Register with Composer
    if (Entropy.Composer) {
        Entropy.Composer.registerEditor(addonInfo.name, renderLightUI);
        
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer(addonInfo.name, (id: string, params: any) => {
                renderLight(id, params);
            });
        }
    }

    // Register a default "Basic Point Light" component
    if (Entropy.Composer) {
        Entropy.Composer.registerComponent(addonInfo.name, "basic_light", "Basic Point Light", lightState.currentParams);
    }

    // Main UI Tab
    const tab = addon.UI.createTab({
        title: "Light Hive",
        onRender: () => {
            renderLightUI(tab);
            
            if (lightState.savedComponents.length > 0) {
                Entropy.UI.Widget.label(tab, { text: "Saved Presets", bold: true });
                lightState.savedComponents.forEach(comp => {
                    Entropy.UI.Widget.button(tab, {
                        text: `📂 Load ${comp.name}`,
                        onClick: () => {
                            lightState.activeComponentId = comp.id;
                            refreshPreview();
                        }
                    });
                });
            }
        }
    });

    // --- Tools Registration ---

    let newComponentName = "New Light";

    const persistState = (newComponent = false) => {
        let id = ""; // careful
        
        // persist state
        if (newComponent) {
            id = Entropy.generateUUID();

            lightState.savedComponents.push({
                id,
                name: newComponentName,
                params: JSON.parse(JSON.stringify(lightState.currentParams))
            });

            if (Entropy.Composer) {
                Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, lightState.currentParams);
            }
        }

        // at least, save the current state
        addon.IO.save(lightState);

        return id;
    }


    addon.registerTool({
        name: "spawn_point_light",
        description: "Spawn a new point light and register it as a component for the Game Composer.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name of the light (e.g., 'Red Beacon')." },
                position: { type: "array", items: { type: "number" }, description: "[x, y, z] position." },
                color: { type: "array", items: { type: "number" }, description: "RGB color." },
                intensity: { type: "number", description: "Brightness." },
                maxDistance: { type: "number", description: "Radius." }
            },
            required: ["name", "position"]
        }
    }, (args: any) => {
        Entropy.println("Spawning light component via tool: " + args.name);
        
        const id = Entropy.generateUUID();
        const params: LightParams = {
            color: args.color || [1.0, 1.0, 1.0],
            intensity: args.intensity || 10.0,
            maxDistance: args.maxDistance || 50.0
        };

        // 1. Save/Register
        lightState.savedComponents.push({ id, name: args.name, params });
        if (Entropy.Composer) {
            Entropy.Composer.registerComponent(addonInfo.name, id, args.name, params);
        }

        // 2. Render immediately
        renderLight(id, { ...params, _transform: { position: args.position } });
        
        return { success: true, id: id, name: args.name, addonName: addonInfo.name };
    });
});