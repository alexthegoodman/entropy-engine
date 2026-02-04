import { createNoise2D, createNoise3D } from 'simplex-noise';
import Alea from 'alea';
import type { PBRMaterialType } from './addon';

const addonInfo = {
    name: "FlexNoise Terrain",
    version: "3.2.0",
    description: "Highly customizable procedural terrain using simplex-noise and alea",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

let terrainParams = {
    seed: 42,
    frequency: 0.005,
    octaves: 6,
    persistence: 0.5,
    lacunarity: 2.0,
    usePBR: true,
    width: 128,
    height: 128,
    heightScale: 1.5,
    positionY: 0.0,
    terrainColor: [0.3, 0.5, 0.2, 1.0],
    use3D: false,
    time: 0.0,
    autoSyncPBR: false,
    rockThreshold: 0.5,
    pipelineId: null as string | null,
    textureLayers: {
        "Primary": null as string | null,
        "Rockmap": null as string | null,
        "Soil": null as string | null
    }
};

let addonState: {
    currentParams: typeof terrainParams,
    savedComponents: { id: string, name: string, params: typeof terrainParams }[],
    activeComponentId: string | null
} = {
    currentParams: { ...terrainParams },
    savedComponents: [],
    activeComponentId: Entropy.generateUUID()
};

let newComponentName = "New Terrain Component";

let interopState = {
    selectedSlot: "Rockmap" as "Primary" | "Rockmap" | "Soil",
    selectedTextureCompId: ""
};

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

function applyRockmapMask() {
    const res = addonState.currentParams.width;
    const maskData = new Uint8Array(res * res * 4);
    
    // Use Alea with the same seed to match the terrain height generation logic
    const prng = Alea(addonState.currentParams.seed);
    const noise2D = createNoise2D(prng);
    
    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            const idx = (y * res + x) * 4;
            const noiseValue = (fbm(
                noise2D,
                x, y,
                addonState.currentParams.octaves,
                addonState.currentParams.frequency,
                addonState.currentParams.persistence,
                addonState.currentParams.lacunarity
            ) + 1) / 2; // Normalize to 0-1
            
            // If height is above threshold, it's rock (white mask)
            const val = noiseValue > addonState.currentParams.rockThreshold ? 255 : 0;
            maskData[idx] = val;
            maskData[idx + 1] = val;
            maskData[idx + 2] = val;
            maskData[idx + 3] = 255;
        }
    }
    
    const maskId = addon.Texture.create(res, res, maskData);
    addon.Landscape.updateTexture(maskId, "RockmapMask");
}

function applyPBRToSlot(slot: PBRMaterialType) {
    const designerTextures = globalThis.lastPBRDesignerTextures;
    if (designerTextures) {
        Entropy.println(`Applying PBR textures to ${slot}...`);

        // 1. Handle Masks if needed
        if (slot === "Rockmap") {
            applyRockmapMask();
        } else if (slot === "Primary") {
            const res = addonState.currentParams.width;
            const maskData = new Uint8Array(res * res * 4).fill(255);
            const maskId = addon.Texture.create(res, res, maskData);
            addon.Landscape.updateTexture(maskId, "PrimaryMask");
        } else if (slot === "Soil") {
            const res = addonState.currentParams.width;
            const maskData = new Uint8Array(res * res * 4).fill(255);
            const maskId = addon.Texture.create(res, res, maskData);
            addon.Landscape.updateTexture(maskId, "SoilMask");
        }

        // 2. Apply Albedo
        addon.Landscape.updateTexture(designerTextures.diffId, slot);
        
        // 3. Apply Normal
        addon.Landscape.updatePbrTexture(designerTextures.norId, "Normal", slot);
        
        // 4. Apply PBR Params
        addon.Landscape.updatePbrTexture(designerTextures.armId, "AORoughnessMetallic", slot);
        
        Entropy.println(`✓ ${slot} updated!`);
    }
}

function applyPBRFromDesigner() {
    applyPBRToSlot("Rockmap");
}

function restoreLayerTextures() {
    if (!Entropy.Composer) return;
    
    const layers = ["Primary", "Rockmap", "Soil"];
    const texAddonName = "PBR Texture Designer Pro";
    const components = Entropy.Composer.getComponents(texAddonName) || {};
    
    layers.forEach(slot => {
        // Safe access in case textureLayers is undefined in old saves
        const layersMap = addonState.currentParams.textureLayers || {};
        const compId = layersMap[slot as "Primary" | "Rockmap" | "Soil"];
        
        if (compId && components[compId]) {
             const renderer = Entropy.Composer?.getRenderer(texAddonName);
             if (renderer) {
                 // Regenerate textures in the designer (updates globalThis.lastPBRDesignerTextures)
                 // We use a silent ID to avoid messing up the main preview if possible, 
                 // though the PBR addon currently updates its single global state.
                 renderer("temp_interop_restore", components[compId].params);
                 
                 // Apply to landscape
                 applyPBRToSlot(slot as any);
             }
        }
    });
}

// Global listener for designer updates
globalThis.onPBRDesignerUpdate = () => {
    if (addonState.currentParams.usePBR && addonState.currentParams.autoSyncPBR) {
        applyPBRFromDesigner();
    }
};

async function generateTerrain(params: typeof terrainParams & { _transform?: { position: [number, number, number], scale: [number, number, number] } }, id: string = "default") {
    Entropy.println(`Regenerating FlexNoise Terrain (${id}): ${params.width}x${params.height}...`);
    
    // Use Alea for robust seeded random generation
    const prng = Alea(params.seed);
    const noise2D = createNoise2D(prng);
    const noise3D = createNoise3D(prng);
    
    const heights = [];
    
    for (let y = 0; y < params.height; y++) {
        for (let x = 0; x < params.width; x++) {
            let noiseValue;
            if (params.use3D) {
                noiseValue = 0;
                let amplitude = 1;
                let freq = params.frequency;
                let maxValue = 0;
                for (let i = 0; i < params.octaves; i++) {
                    noiseValue += noise3D(x * freq, y * freq, params.time) * amplitude;
                    maxValue += amplitude;
                    amplitude *= params.persistence;
                    freq *= params.lacunarity;
                }
                noiseValue /= maxValue;
            } else {
                noiseValue = fbm(
                    noise2D,
                    x, y,
                    params.octaves,
                    params.frequency,
                    params.persistence,
                    params.lacunarity
                );
            }
            
            const height = noiseValue * params.heightScale;
            heights.push(height);
        }
    }
    
    let pipelineId = "default";
    if (!params.usePBR) {
        pipelineId = Entropy.Pipeline.create({
            name: "terrain_custom_color",
            pbr: false,
            fragmentShader: `
                struct VertexOutput {
                    @location(0) color: vec4<f32>,
                }
                @fragment
                fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                    return vec4<f32>(${params.terrainColor[0]}, ${params.terrainColor[1]}, ${params.terrainColor[2]}, 1.0);
                }
            `
        });
    }

    const posX = params._transform?.position?.[0] || 0;
    const posY = (params._transform?.position?.[1] || 0) + params.positionY;
    const posZ = params._transform?.position?.[2] || 0;

    addon.Landscape.create({
        id: id,
        width: params.width,
        height: params.height,
        heights: heights,
        noiseId: null,
        position: [posX, posY, posZ],
        pipelineId: pipelineId,
        renderRole: "Terrain"
    } as any);

    if (params.usePBR) {
        restoreLayerTextures();
    }
}

addon.onInit(async () => {
    Entropy.println("FlexNoise Terrain Addon (Alea-seeded) Initializing...");

    const savedData = addon.IO.load();
    if (savedData) {
        addonState = { ...addonState, ...savedData };
        // Ensure textureLayers exists if loading old save
        if (!addonState.currentParams.textureLayers) {
            addonState.currentParams.textureLayers = {
                "Primary": null,
                "Rockmap": null,
                "Soil": null
            };
        }

        // Register components with the composer
        if (Entropy.Composer) {
            addonState.savedComponents.forEach(comp => {
                Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
            });
        }
    }

    const renderTerrainUI = (tab: string) => {
        Entropy.Addon.setVisibility(addonInfo.name, true);
        Entropy.UI.Widget.label(tab, { text: "⛰️ FlexNoise Terrain Settings", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "💾 Save All to Project",
            onClick: () => {
                addon.IO.save(addonState);
                // Re-register
                if (Entropy.Composer) {
                    addonState.savedComponents.forEach(comp => {
                        Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                    });
                }
                Entropy.println("Terrain state saved!");
            }
        });

        Entropy.UI.Widget.label(tab, { text: "📦 Components", bold: true });
        
        Entropy.UI.Widget.numericInput(tab, {
            label: "Component Name",
            value: 0, // Numeric input doesn't support text yet? Use label for now if so.
            // Actually let's assume Widget.textInput exists or just use a workaround.
        } as any);

        Entropy.UI.Widget.button(tab, {
            text: "➕ Save Current as Component",
            onClick: () => {
                const id = Entropy.generateUUID();
                addonState.savedComponents.push({
                    id,
                    name: newComponentName,
                    params: JSON.parse(JSON.stringify(addonState.currentParams))
                });
                if (Entropy.Composer) {
                    Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, addonState.currentParams);
                }
                Entropy.println(`Saved component: ${newComponentName}`);
            }
        });

        addonState.savedComponents.forEach(comp => {
            Entropy.UI.Widget.button(tab, {
                text: `📂 Load & Render: ${comp.name}`,
                onClick: () => {
                    addonState.currentParams = JSON.parse(JSON.stringify(comp.params));
                    // Ensure textureLayers exists on load
                    if (!addonState.currentParams.textureLayers) {
                        addonState.currentParams.textureLayers = { "Primary": null, "Rockmap": null, "Soil": null };
                    }
                    addonState.activeComponentId = comp.id;
                    generateTerrain(addonState.currentParams, comp.id);
                }
            });
        });

        Entropy.UI.Widget.label(tab, { text: "--------------------------------" });
        Entropy.UI.Widget.label(tab, { text: "🎲 Active Parameters", bold: true });
        
        Entropy.UI.Widget.numericInput(tab, {
            label: "Seed",
            value: addonState.currentParams.seed,
            onChange: (val: string) => {
                addonState.currentParams.seed = parseInt(val);
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: addonState.currentParams.use3D ? "🧊 Noise: 3D (Animated)" : "📄 Noise: 2D (Static)",
            onClick: () => {
                addonState.currentParams.use3D = !addonState.currentParams.use3D;
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        if (addonState.currentParams.use3D) {
            Entropy.UI.Widget.slider(tab, {
                label: "3D Time/Depth",
                value: addonState.currentParams.time,
                min: 0.0,
                max: 10.0,
                onChange: (val: string) => {
                    addonState.currentParams.time = parseFloat(val);
                    generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });
        }

        Entropy.UI.Widget.slider(tab, {
            label: "Frequency",
            value: addonState.currentParams.frequency,
            min: 0.0001,
            max: 0.05,
            onChange: (val: string) => {
                addonState.currentParams.frequency = parseFloat(val);
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Octaves",
            value: addonState.currentParams.octaves,
            min: 1,
            max: 12,
            onChange: (val: string) => {
                addonState.currentParams.octaves = parseInt(val);
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Persistence",
            value: addonState.currentParams.persistence,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.persistence = parseFloat(val);
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Lacunarity",
            value: addonState.currentParams.lacunarity,
            min: 1.0,
            max: 4.0,
            onChange: (val: string) => {
                addonState.currentParams.lacunarity = parseFloat(val);
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.label(tab, { text: "📐 Geometry & Scale", bold: true });

        Entropy.UI.Widget.slider(tab, {
            label: "Height Scale",
            value: addonState.currentParams.heightScale,
            min: 0.1,
            max: 10.0,
            onChange: (val: string) => {
                addonState.currentParams.heightScale = parseFloat(val);
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Y Position",
            value: addonState.currentParams.positionY,
            min: -500.0,
            max: 500.0,
            onChange: (val: string) => {
                addonState.currentParams.positionY = parseFloat(val);
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.label(tab, { text: "🖥️ Resolution", bold: true });
        
        const resolutions = [64, 128, 256, 512];
        resolutions.forEach(res => {
            Entropy.UI.Widget.button(tab, {
                text: `Set Resolution: ${res}x${res}`,
                onClick: () => {
                    addonState.currentParams.width = res;
                    addonState.currentParams.height = res;
                    generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });
        });

        Entropy.UI.Widget.label(tab, { text: "🎨 Visuals", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: addonState.currentParams.usePBR ? "✨ Mode: PBR (Realistic)" : "🎨 Mode: Custom Color",
            onClick: () => {
                addonState.currentParams.usePBR = !addonState.currentParams.usePBR;
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        if (!addonState.currentParams.usePBR) {
            Entropy.UI.Widget.colorInput(tab, {
                label: "Terrain Color",
                color: addonState.currentParams.terrainColor,
                onChange: (newColor: number[]) => {
                    addonState.currentParams.terrainColor = newColor;
                    generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });
        } else {
            // Entropy.UI.Widget.slider(tab, {
            //     label: "🪨 Rock Threshold",
            //     value: addonState.currentParams.rockThreshold,
            //     min: 0.0,
            //     max: 1.0,
            //     onChange: (val: string) => {
            //         addonState.currentParams.rockThreshold = parseFloat(val);
            //         if (addonState.currentParams.autoSyncPBR) {
            //             applyPBRFromDesigner();
            //         }
            //     }
            // });

            // Entropy.UI.Widget.button(tab, {
            //     text: `✨ Apply from PBR Designer to ${interopState.selectedSlot}`,
            //     onClick: () => {
            //         const designerTextures = globalThis.lastPBRDesignerTextures;
            //         if (designerTextures) {
            //             applyPBRToSlot(interopState.selectedSlot);
            //         } else {
            //             Entropy.println("❌ No textures found in PBR Designer. Open it first!");
            //         }
            //     }
            // });

            // Entropy.UI.Widget.button(tab, {
            //     text: addonState.currentParams.autoSyncPBR ? "🔄 Auto-sync: ON" : "🔄 Auto-sync: OFF",
            //     onClick: () => {
            //         addonState.currentParams.autoSyncPBR = !addonState.currentParams.autoSyncPBR;
            //         if (addonState.currentParams.autoSyncPBR) {
            //             applyPBRFromDesigner();
            //         }
            //         generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); // Refresh UI
            //     }
            // });
        }

        Entropy.UI.Widget.label(tab, { text: "🔗 Texture Interop", bold: true });
        
        const slots = ["Primary", "Rockmap", "Soil"];
        Entropy.UI.Widget.dropdown(tab, {
            label: "Target Slot",
            options: slots,
            selectedIndex: slots.indexOf(interopState.selectedSlot),
            onChange: (idx) => {
                interopState.selectedSlot = slots[parseInt(idx)] as any;
            }
        });

        if (Entropy.Composer) {
            const texAddonName = "PBR Texture Designer Pro";
            const texComponents = Entropy.Composer.getComponents(texAddonName) || {};
            const texCompIds = Object.keys(texComponents);
            const texCompNames = texCompIds.map(id => texComponents[id].name);

            if (texCompIds.length > 0) {
                Entropy.UI.Widget.dropdown(tab, {
                    label: "Texture Component",
                    options: texCompNames,
                    selectedIndex: Math.max(0, texCompIds.indexOf(interopState.selectedTextureCompId)),
                    onChange: (idx) => {
                        interopState.selectedTextureCompId = texCompIds[parseInt(idx)];
                    }
                });

                Entropy.UI.Widget.button(tab, {
                    text: "✨ Apply Selected Component",
                    onClick: () => {
                        const compId = interopState.selectedTextureCompId || texCompIds[0];
                        const comp = texComponents[compId];
                        if (comp) {
                            // 1. SAVE THE ASSOCIATION
                            if (!addonState.currentParams.textureLayers) {
                                addonState.currentParams.textureLayers = { "Primary": null, "Rockmap": null, "Soil": null };
                            }
                            addonState.currentParams.textureLayers[interopState.selectedSlot] = compId;

                            const renderer = Entropy.Composer?.getRenderer(texAddonName);
                            if (renderer) {
                                // This updates globalThis.lastPBRDesignerTextures
                                renderer("temp_interop_gen", comp.params);
                                applyPBRToSlot(interopState.selectedSlot);
                            }
                            
                            Entropy.println(`Linked component ${comp.name} to ${interopState.selectedSlot}`);
                        }
                    }
                });
            } else {
                Entropy.UI.Widget.label(tab, { text: "(No Texture Components saved yet)" });
            }
        }

        Entropy.UI.Widget.label(tab, { text: "🎭 Terrain Presets", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "🏔️ Sharp Mountains",
            onClick: () => {
                addonState.currentParams.frequency = 0.01;
                addonState.currentParams.octaves = 8;
                addonState.currentParams.persistence = 0.5;
                addonState.currentParams.heightScale = 7.0;
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🏜️ Rolling Hills",
            onClick: () => {
                addonState.currentParams.frequency = 0.003;
                addonState.currentParams.octaves = 4;
                addonState.currentParams.persistence = 0.3;
                addonState.currentParams.heightScale = 1.5;
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🌊 Sea Bed",
            onClick: () => {
                addonState.currentParams.frequency = 0.002;
                addonState.currentParams.octaves = 3;
                addonState.currentParams.persistence = 0.4;
                addonState.currentParams.heightScale = 1.25;
                addonState.currentParams.positionY = -15.0;
                generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor(addonInfo.name, renderTerrainUI);
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer(addonInfo.name, (id: string, params: any) => {
                generateTerrain(params, id);
            });
        }
    }

    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            addonState = { ...addonState, ...data };

            // Register components with the composer
            if (Entropy.Composer) {
                addonState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                });
            }

            generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
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

    generateTerrain(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());

    const tab = addon.UI.createTab({
        title: "FlexNoise",
        onRender: async () => {
            renderTerrainUI(tab);
        }
    });
});
