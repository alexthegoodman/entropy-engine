// Terrain Generation Addon
// Demonstrates procedural heightmap generation in JavaScript

const addon = await Entropy.Addon.register({
    name: "Procedural Terrain",
    version: "1.0.0",
    description: "Generates terrain using Perlin noise",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let terrainParams = {
    scale: 0.1,
    octaves: 3,
    heightMultiplier: 1.0
};

function generateTerrain() {
    const width = 64;
    const height = 64;
    const heights = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let h = 0;
            let freq = terrainParams.scale;
            let amp = 1.0;
            for(let i=0; i < terrainParams.octaves; i++) {
                h += Math.sin(x * freq) * Math.cos(y * freq) * amp; // Simple deterministic wave for now
                freq *= 2;
                amp *= 0.5;
            }
            heights[y * width + x] = (h + 1) / 2 * terrainParams.heightMultiplier;
        }
    }

    addon.Landscape.create({
        width: width,
        height: height,
        heights: Array.from(heights),
        position: [0, 0, 0]
    });
}

Entropy.Addon.onInit(async () => {
    Entropy.println("Procedural Terrain Initializing...");

    generateTerrain();

    await Entropy.UI.createWindow({
        title: "Terrain Settings",
        resizable: true,
        defaultSize: { width: 300, height: 200 },
        onRender: async () => {
            await Entropy.UI.Widget.label("Terrain Controls", { bold: true });
            
            // Note: In a real immediate mode JS API, we'd return values from widgets
            // For this demo, we'll use a button to 'Re-generate'
            await Entropy.UI.Widget.button("Generate New Terrain", {
                onClick: () => {
                    generateTerrain();
                }
            });
        }
    });
});
