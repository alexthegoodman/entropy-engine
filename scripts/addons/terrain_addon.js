// Terrain Generation Addon
// Demonstrates procedural heightmap generation in JavaScript via Rust Noise API

const addon = await Entropy.Addon.register({
    name: "Procedural Terrain",
    version: "1.1.0",
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
    octaves: 6
};

async function generateTerrain() {
    // 1. Create a noise handle in Rust
    const noiseId = await addon.Noise.create({
        type: "fbm",
        source: "perlin",
        seed: terrainParams.seed,
        frequency: terrainParams.frequency,
        octaves: terrainParams.octaves
    });

    // 2. Spawn landscape using that noise handle (Heavy data stays in Rust!)
    addon.Landscape.create({
        width: 128,
        height: 128,
        noiseId: noiseId,
        position: [0, 0, 0]
    });
}

Entropy.Addon.onInit(async () => {
    Entropy.println("Procedural Terrain Initializing...");

    generateTerrain();

    await Entropy.UI.createWindow({
        title: "Rust Noise Settings",
        resizable: true,
        defaultSize: { width: 300, height: 200 },
        onRender: async () => {
            await Entropy.UI.Widget.label("Noise Parameters", { bold: true });
            
            await Entropy.UI.Widget.button("Randomize Seed & Regenerate", {
                onClick: () => {
                    terrainParams.seed = Math.floor(Math.random() * 1000);
                    generateTerrain();
                }
            });

            await Entropy.UI.Widget.label(`Current Seed: ${terrainParams.seed}`);
        }
    });
});
