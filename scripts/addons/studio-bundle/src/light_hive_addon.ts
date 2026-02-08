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

let lightState: {
    currentParams: LightParams;
    savedComponents: { id: string, name: string, params: LightParams }[];
} = {
    currentParams: {
        color: [1.0, 1.0, 1.0],
        intensity: 5.0,
        maxDistance: 50.0
    },
    savedComponents: []
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
            lightState = { ...lightState, ...data };

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
                            lightState.currentParams = JSON.parse(JSON.stringify(comp.params));
                            refreshPreview();
                        }
                    });
                });
            }
        }
    });

    // --- Tools Registration ---

    addon.registerTool({
        name: "spawn_point_light",
        description: "Place a new point light in the scene at a specific position.",
        parameters: {
            type: "object",
            properties: {
                position: { 
                    type: "array", 
                    items: { type: "number" }, 
                    minItems: 3, 
                    maxItems: 3,
                    description: "The [x, y, z] position of the light." 
                },
                color: { 
                    type: "array", 
                    items: { type: "number" }, 
                    minItems: 3, 
                    maxItems: 3,
                    description: "The RGB color of the light." 
                },
                intensity: { type: "number", description: "Brightness of the light (e.g., 5.0 to 50.0)." },
                maxDistance: { type: "number", description: "Radius of the light's influence." }
            },
            required: ["position"]
        }
    }, (args: any) => {
        Entropy.println("Spawning point light via tool: " + JSON.stringify(args));
        
        const params: LightParams & { _transform: { position: [number, number, number] } } = {
            color: args.color || [1.0, 1.0, 1.0],
            intensity: args.intensity || 10.0,
            maxDistance: args.maxDistance || 50.0,
            _transform: { position: args.position }
        };

        renderLight(Entropy.generateUUID(), params);
        
        return { success: true, position: args.position, color: params.color };
    });
});