import { createNoise2D, createNoise3D } from 'simplex-noise';
import Alea from 'alea';

// FBM (Fractional Brownian Motion) implementation using the library
function fbm(noise2D: (x: number, y: number) => number, x: number, y: number, octaves: number, frequency: number, persistence: number, lacunarity: number) {
    let total = 0;
    let amplitude = 1;
    let maxValue = 0;
    let freq = frequency;

    for (let i = 0; i < octaves; i++) {
        total += noise2D(x * freq, y * freq) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        freq *= lacunarity;
    }

    return total / maxValue;
}

const addon = Entropy.Addon.register({
    name: "FlexNoise Terrain",
    version: "3.2.0",
    description: "Highly customizable procedural terrain using simplex-noise and alea",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let terrainParams = {
    seed: 42,
    frequency: 0.005,
    octaves: 6,
    persistence: 0.5,
    lacunarity: 2.0,
    usePBR: true,
    width: 128,
    height: 128,
    heightScale: 15.0,
    positionY: 0.0,
    terrainColor: [0.3, 0.5, 0.2, 1.0],
    use3D: false,
    time: 0.0,
    autoSyncPBR: false,
    rockThreshold: 0.5,
    pipelineId: null
};

function applyPBRFromDesigner() {
    const designerTextures = globalThis.lastPBRDesignerTextures;
    if (designerTextures) {
        // 1. Generate a RockmapMask based on height
        // We'll use a 128x128 mask for simplicity, or match terrain res
        const res = terrainParams.width;
        const maskData = new Uint8Array(res * res * 4);
        
        // Use Alea with the same seed to match the terrain height generation logic
        const prng = Alea(terrainParams.seed);
        const noise2D = createNoise2D(prng);
        
        for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
                const idx = (y * res + x) * 4;
                const noiseValue = (fbm(
                    noise2D,
                    x, y,
                    terrainParams.octaves,
                    terrainParams.frequency,
                    terrainParams.persistence,
                    terrainParams.lacunarity
                ) + 1) / 2; // Normalize to 0-1
                
                // If height is above threshold, it's rock (white mask)
                const val = noiseValue > terrainParams.rockThreshold ? 255 : 0;
                maskData[idx] = val;
                maskData[idx + 1] = val;
                maskData[idx + 2] = val;
                maskData[idx + 3] = 255;
            }
        }
        
        const maskId = addon.Texture.create(res, res, maskData);

        addon.Landscape.updateTexture(maskId, "RockmapMask");

        // 2. Apply Albedo & Mask
        addon.Landscape.updateTexture(designerTextures.diffId, "Rockmap");
        
        
        // 3. Apply Normal
        addon.Landscape.updatePbrTexture(designerTextures.norId, "Normal", "Rockmap");
        
        // 4. Apply PBR Params
        addon.Landscape.updatePbrTexture(designerTextures.armId, "AORoughnessMetallic", "Rockmap");
    }
}

// Global listener for designer updates
globalThis.onPBRDesignerUpdate = () => {
    if (terrainParams.usePBR && terrainParams.autoSyncPBR) {
        applyPBRFromDesigner();
    }
};

async function generateTerrain() {
    Entropy.println(`Regenerating FlexNoise Terrain: ${terrainParams.width}x${terrainParams.height}...`);
    
    // Use Alea for robust seeded random generation
    const prng = Alea(terrainParams.seed);
    const noise2D = createNoise2D(prng);
    const noise3D = createNoise3D(prng);
    
    const heights = [];
    
    for (let y = 0; y < terrainParams.height; y++) {
        for (let x = 0; x < terrainParams.width; x++) {
            let noiseValue;
            if (terrainParams.use3D) {
                noiseValue = 0;
                let amplitude = 1;
                let freq = terrainParams.frequency;
                let maxValue = 0;
                for (let i = 0; i < terrainParams.octaves; i++) {
                    noiseValue += noise3D(x * freq, y * freq, terrainParams.time) * amplitude;
                    maxValue += amplitude;
                    amplitude *= terrainParams.persistence;
                    freq *= terrainParams.lacunarity;
                }
                noiseValue /= maxValue;
            } else {
                noiseValue = fbm(
                    noise2D,
                    x, y,
                    terrainParams.octaves,
                    terrainParams.frequency,
                    terrainParams.persistence,
                    terrainParams.lacunarity
                );
            }
            
            const height = noiseValue * terrainParams.heightScale;
            heights.push(height);
        }
    }
    
    let pipelineId = "default";
    if (!terrainParams.usePBR) {
        pipelineId = Entropy.Pipeline.create({
            name: "terrain_custom_color",
            pbr: false,
            fragmentShader: `
                struct VertexOutput {
                    @location(0) color: vec4<f32>,
                }
                @fragment
                fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                    return vec4<f32>(${terrainParams.terrainColor[0]}, ${terrainParams.terrainColor[1]}, ${terrainParams.terrainColor[2]}, 1.0);
                }
            `
        });
    }

    addon.Landscape.create({
        width: terrainParams.width,
        height: terrainParams.height,
        heights: heights,
        noiseId: null,
        position: [0, terrainParams.positionY, 0],
        pipelineId: pipelineId,
        renderRole: "Terrain"
    } as any);
}

addon.onInit(async () => {
    Entropy.println("FlexNoise Terrain Addon (Alea-seeded) Initializing...");

    const savedData = addon.IO.load();
    if (savedData) {
        terrainParams = { ...terrainParams, ...savedData };
    }

    const renderTerrainUI = (tab: string) => {
        Entropy.UI.Widget.label(tab, { text: "⛰️ FlexNoise Terrain Settings", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "💾 Save Terrain Settings",
            onClick: () => {
                addon.IO.save(terrainParams);
                Entropy.println("Terrain settings saved!");
            }
        });

        Entropy.UI.Widget.label(tab, { text: "🎲 Noise Fundamentals", bold: true });
        
        Entropy.UI.Widget.numericInput(tab, {
            label: "Seed",
            value: terrainParams.seed,
            onChange: (val: string) => {
                terrainParams.seed = parseInt(val);
                generateTerrain();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: terrainParams.use3D ? "🧊 Noise: 3D (Animated)" : "📄 Noise: 2D (Static)",
            onClick: () => {
                terrainParams.use3D = !terrainParams.use3D;
                generateTerrain();
            }
        });

        if (terrainParams.use3D) {
            Entropy.UI.Widget.slider(tab, {
                label: "3D Time/Depth",
                value: terrainParams.time,
                min: 0.0,
                max: 10.0,
                onChange: (val: string) => {
                    terrainParams.time = parseFloat(val);
                    generateTerrain();
                }
            });
        }

        Entropy.UI.Widget.slider(tab, {
            label: "Frequency",
            value: terrainParams.frequency,
            min: 0.0001,
            max: 0.05,
            onChange: (val: string) => {
                terrainParams.frequency = parseFloat(val);
                generateTerrain();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Octaves",
            value: terrainParams.octaves,
            min: 1,
            max: 12,
            onChange: (val: string) => {
                terrainParams.octaves = parseInt(val);
                generateTerrain();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Persistence",
            value: terrainParams.persistence,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                terrainParams.persistence = parseFloat(val);
                generateTerrain();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Lacunarity",
            value: terrainParams.lacunarity,
            min: 1.0,
            max: 4.0,
            onChange: (val: string) => {
                terrainParams.lacunarity = parseFloat(val);
                generateTerrain();
            }
        });

        Entropy.UI.Widget.label(tab, { text: "📐 Geometry & Scale", bold: true });

        Entropy.UI.Widget.slider(tab, {
            label: "Height Scale",
            value: terrainParams.heightScale,
            min: 0.1,
            max: 100.0,
            onChange: (val: string) => {
                terrainParams.heightScale = parseFloat(val);
                generateTerrain();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Y Position",
            value: terrainParams.positionY,
            min: -500.0,
            max: 500.0,
            onChange: (val: string) => {
                terrainParams.positionY = parseFloat(val);
                generateTerrain();
            }
        });

        Entropy.UI.Widget.label(tab, { text: "🖥️ Resolution", bold: true });
        
        const resolutions = [64, 128, 256, 512];
        resolutions.forEach(res => {
            Entropy.UI.Widget.button(tab, {
                text: `Set Resolution: ${res}x${res}`,
                onClick: () => {
                    terrainParams.width = res;
                    terrainParams.height = res;
                    generateTerrain();
                }
            });
        });

        Entropy.UI.Widget.label(tab, { text: "🎨 Visuals", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: terrainParams.usePBR ? "✨ Mode: PBR (Realistic)" : "🎨 Mode: Custom Color",
            onClick: () => {
                terrainParams.usePBR = !terrainParams.usePBR;
                generateTerrain();
            }
        });

        if (!terrainParams.usePBR) {
            Entropy.UI.Widget.colorInput(tab, {
                label: "Terrain Color",
                color: terrainParams.terrainColor,
                onChange: (newColor: number[]) => {
                    terrainParams.terrainColor = newColor;
                    generateTerrain();
                }
            });
        } else {
            Entropy.UI.Widget.slider(tab, {
                label: "🪨 Rock Threshold",
                value: terrainParams.rockThreshold,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    terrainParams.rockThreshold = parseFloat(val);
                    if (terrainParams.autoSyncPBR) {
                        applyPBRFromDesigner();
                    }
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "✨ Apply from PBR Designer",
                onClick: () => {
                    const designerTextures = globalThis.lastPBRDesignerTextures;
                    if (designerTextures) {
                        Entropy.println("Applying textures from PBR Designer...");
                        applyPBRFromDesigner();
                        Entropy.println("✓ Textures applied to Primary material!");
                    } else {
                        Entropy.println("❌ No textures found in PBR Designer. Open it first!");
                    }
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: terrainParams.autoSyncPBR ? "🔄 Auto-sync: ON" : "🔄 Auto-sync: OFF",
                onClick: () => {
                    terrainParams.autoSyncPBR = !terrainParams.autoSyncPBR;
                    if (terrainParams.autoSyncPBR) {
                        applyPBRFromDesigner();
                    }
                    generateTerrain(); // Refresh UI
                }
            });
        }

        Entropy.UI.Widget.label(tab, { text: "🎭 Terrain Presets", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "🏔️ Sharp Mountains",
            onClick: () => {
                terrainParams.frequency = 0.01;
                terrainParams.octaves = 8;
                terrainParams.persistence = 0.5;
                terrainParams.heightScale = 40.0;
                generateTerrain();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🏜️ Rolling Hills",
            onClick: () => {
                terrainParams.frequency = 0.003;
                terrainParams.octaves = 4;
                terrainParams.persistence = 0.3;
                terrainParams.heightScale = 10.0;
                generateTerrain();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🌊 Sea Bed",
            onClick: () => {
                terrainParams.frequency = 0.002;
                terrainParams.octaves = 3;
                terrainParams.persistence = 0.4;
                terrainParams.heightScale = 5.0;
                terrainParams.positionY = -15.0;
                generateTerrain();
            }
        });
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("FlexNoise Terrain", renderTerrainUI);
    }

    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            terrainParams = { ...terrainParams, ...data };
            generateTerrain();
        }
    });

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

    generateTerrain();

    const tab = addon.UI.createTab({
        title: "FlexNoise",
        onRender: async () => {
            renderTerrainUI(tab);
        }
    });
});
