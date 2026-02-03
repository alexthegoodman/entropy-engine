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

async function generateTerrain() {
    // 1. Create a noise handle in Rust
    const noiseId = addon.Noise.create({
        type: "fbm",
        source: "perlin",
        seed: terrainParams.seed,
        frequency: terrainParams.frequency,
        octaves: terrainParams.octaves
    });

    let pipelineId = "default";
    if (!terrainParams.usePBR) {
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
        text: "💾 Save Settings",
        onClick: () => {
            addon.IO.save(terrainParams);
            Entropy.println("Terrain settings saved!");
        }
    });
    
    Entropy.UI.Widget.button(windowId, {
        text: "Randomize Seed & Regenerate",
        onClick: () => {
            terrainParams.seed = Math.floor(Math.random() * 1000);
            generateTerrain();
        }
    });

    Entropy.UI.Widget.button(windowId, {
        text: terrainParams.usePBR ? "Switch to non-PBR (Green)" : "Switch to PBR",
        onClick: () => {
            terrainParams.usePBR = !terrainParams.usePBR;
            generateTerrain();
        }
    });

    Entropy.UI.Widget.label(windowId, { text: `Current Seed: ${terrainParams.seed}` });
    Entropy.UI.Widget.label(windowId, { text: `Mode: ${terrainParams.usePBR ? "PBR" : "Non-PBR"}` });
};

addon.onInit(async () => {
    Entropy.println("Procedural Terrain Initializing...");

    const saved = addon.IO.load();
    if (saved) {
        terrainParams = { ...terrainParams, ...saved };
    }

    generateTerrain();

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("Simple Procedural Terrain", renderTerrainUI);
    }

    const windowId = addon.UI.createTab({
        title: "Rust Noise Settings",
        onRender: () => {
            renderTerrainUI(windowId);
        }
    });
});
