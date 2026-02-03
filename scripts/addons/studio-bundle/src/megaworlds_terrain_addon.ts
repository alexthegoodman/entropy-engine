// Terrain Generation Addon
// Demonstrates procedural heightmap generation in JavaScript via Rust Noise API

const addon = Entropy.Addon.register({
    name: "Simple Procedural Terrain",
    version: "1.2.0",
    description: "Generates terrain using Rust-side noise",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let terrainParams = {
    seed: Math.floor(Math.random() * 1000),
    frequency: 0.02,
    octaves: 6,
    usePBR: true
};

let addonState: {
    currentParams: typeof terrainParams,
    savedComponents: { id: string, name: string, params: typeof terrainParams }[],
    activeComponentId: string | null
} = {
    currentParams: { ...terrainParams },
    savedComponents: [],
    activeComponentId: "default"
};

let newComponentName = "New Rust Terrain Component";

async function generateTerrain(params: typeof terrainParams, id: string = "default") {
    // 1. Create a noise handle in Rust
    const noiseId = addon.Noise.create({
        type: "fbm",
        source: "perlin",
        seed: params.seed,
        frequency: params.frequency,
        octaves: params.octaves
    });

    let pipelineId = "default";
    if (!params.usePBR) {
        // Create a simple custom non-PBR pipeline (Green Tint)
        pipelineId = Entropy.Pipeline.create({
            name: "terrain_green",
            pbr: false,
            fragmentShader: `
                @fragment
                fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                    return vec4<f32>(0.2, 0.8, 0.2, 1.0);
                }
            `
        });
    }

    // 2. Spawn landscape using that noise handle (Heavy data stays in Rust!)
    addon.Landscape.create({
        id: id,
        width: 128,
        height: 128,
        noiseId: noiseId,
        position: [0, 0, 0],
        pipelineId: pipelineId,
        renderRole: "Terrain"
    } as any);
}

const renderTerrainUI = (windowId: string) => {
    Entropy.UI.Widget.label(windowId, { text: "Noise Parameters", bold: true });

    Entropy.UI.Widget.button(windowId, {
        text: "💾 Save All to Project",
        onClick: () => {
            addon.IO.save(addonState);
            if (Entropy.Composer) {
                addonState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent("Simple Procedural Terrain", comp.id, comp.name, comp.params);
                });
            }
            Entropy.println("Terrain state saved!");
        }
    });

    Entropy.UI.Widget.label(windowId, { text: "📦 Components", bold: true });
    
    Entropy.UI.Widget.button(windowId, {
        text: "➕ Save Current as Component",
        onClick: () => {
            const id = Math.random().toString(36).substr(2, 9);
            addonState.savedComponents.push({
                id,
                name: newComponentName,
                params: JSON.parse(JSON.stringify(addonState.currentParams))
            });
            if (Entropy.Composer) {
                Entropy.Composer!.registerComponent("Simple Procedural Terrain", id, newComponentName, addonState.currentParams);
            }
            Entropy.println(`Saved component: ${newComponentName}`);
        }
    });

    addonState.savedComponents.forEach(comp => {
        Entropy.UI.Widget.button(windowId, {
            text: `📂 Load & Render: ${comp.name}`,
            onClick: () => {
                addonState.currentParams = JSON.parse(JSON.stringify(comp.params));
                addonState.activeComponentId = comp.id;
                generateTerrain(addonState.currentParams, comp.id);
            }
        });
    });

    Entropy.UI.Widget.label(windowId, { text: "--------------------------------" });
    
    Entropy.UI.Widget.button(windowId, {
        text: "Randomize Seed & Regenerate",
        onClick: () => {
            addonState.currentParams.seed = Math.floor(Math.random() * 1000);
            generateTerrain(addonState.currentParams, addonState.activeComponentId || "default");
        }
    });

    Entropy.UI.Widget.button(windowId, {
        text: addonState.currentParams.usePBR ? "Switch to non-PBR (Green)" : "Switch to PBR",
        onClick: () => {
            addonState.currentParams.usePBR = !addonState.currentParams.usePBR;
            generateTerrain(addonState.currentParams, addonState.activeComponentId || "default");
        }
    });

    Entropy.UI.Widget.label(windowId, { text: `Current Seed: ${addonState.currentParams.seed}` });
    Entropy.UI.Widget.label(windowId, { text: `Mode: ${addonState.currentParams.usePBR ? "PBR" : "Non-PBR"}` });
};

addon.onInit(async () => {
    Entropy.println("Procedural Terrain Initializing...");

    const saved = addon.IO.load();
    if (saved) {
        addonState = { ...addonState, ...saved };
        if (Entropy.Composer) {
            addonState.savedComponents.forEach(comp => {
                Entropy.Composer!.registerComponent("Simple Procedural Terrain", comp.id, comp.name, comp.params);
            });
        }
    }

    generateTerrain(addonState.currentParams, addonState.activeComponentId || "default");

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("Simple Procedural Terrain", renderTerrainUI);
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer("Simple Procedural Terrain", (id: string, params: any) => {
                generateTerrain(params, id);
            });
        }
    }

    const windowId = addon.UI.createTab({
        title: "Rust Noise Settings",
        onRender: () => {
            renderTerrainUI(windowId);
        }
    });
});
