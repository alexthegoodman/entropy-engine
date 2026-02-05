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

// Renderer implementation
function renderLight(id: string, params: LightParams & { _transform?: { position: [number, number, number] } }) {
    const position = params._transform?.position || [0, 0, 0];
    
    addon.Lighting.createPointLight({
        position: position,
        color: params.color,
        intensity: params.intensity,
        maxDistance: params.maxDistance
    });
}

const renderLightUI = (tab: string) => {
    Entropy.UI.Widget.label(tab, { text: "💡 Light Properties", bold: true });
    
    Entropy.UI.Widget.colorInput(tab, {
        label: "Color",
        color: [...lightState.currentParams.color, 1.0] as [number, number, number, number],
        onChange: (col: number[]) => {
            lightState.currentParams.color = [col[0], col[1], col[2]];
            // We don't trigger a full refresh here as lights are usually 
            // updated via the Composer's refresh cycle
        }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Intensity",
        value: lightState.currentParams.intensity,
        min: 0,
        max: 50,
        onChange: (v: string) => {
            lightState.currentParams.intensity = parseFloat(v);
        }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Max Distance",
        value: lightState.currentParams.maxDistance,
        min: 1,
        max: 500,
        onChange: (v: string) => {
            lightState.currentParams.maxDistance = parseFloat(v);
        }
    });

    Entropy.UI.Widget.label(tab, { text: "--------------------------------" });
    
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
    const saved = addon.IO.load();
    if (saved) {
        lightState = { ...lightState, ...saved };
        if (Entropy.Composer) {
            lightState.savedComponents.forEach(comp => {
                Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
            });
        }
    }

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
                        }
                    });
                });
            }
        }
    });
});
