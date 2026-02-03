import { createNoise2D } from 'simplex-noise';
import Alea from 'alea';

const addon = Entropy.Addon.register({
    name: "PBR Texture Designer",
    version: "1.0.0",
    description: "Procedural PBR Texture Generator (diff, disp, nor_gl, arm)",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let texParams = {
    seed: 1234,
    resolution: 512,
    baseColor: [0.5, 0.4, 0.3, 1.0],
    roughness: 0.8,
    metallic: 0.0,
    aoStrength: 1.0,
    
    // Noise for height/disp
    heightFrequency: 0.02,
    heightOctaves: 4,
    heightPersistence: 0.5,
    heightLacunarity: 2.0,
    
    // Normal map
    normalStrength: 10.0,
    
    // Color variation
    colorVariation: 0.1,
    colorNoiseFreq: 0.05
};

// Simple FBM
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

    return (total / maxValue + 1) / 2; // 0..1
}

function saveTextures() {
    const res = texParams.resolution;
    const prng = Alea(texParams.seed);
    const noise2D = createNoise2D(prng);
    const colorPrng = Alea(texParams.seed + 1);
    const colorNoise2D = createNoise2D(colorPrng);

    const diffData = new Uint8Array(res * res * 4);
    const dispData = new Uint8Array(res * res * 4);
    const norData = new Uint8Array(res * res * 4);
    const armData = new Uint8Array(res * res * 4);

    Entropy.println(`Generating PBR textures at ${res}x${res}...`);

    // Helper to get height
    const getHeight = (x: number, y: number) => {
        return fbm(noise2D, x, y, texParams.heightOctaves, texParams.heightFrequency, texParams.heightPersistence, texParams.heightLacunarity);
    };

    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            const idx = (y * res + x) * 4;
            
            // 1. DISP (Height)
            const h = getHeight(x, y);
            const hv = Math.floor(h * 255);
            dispData[idx] = hv;
            dispData[idx + 1] = hv;
            dispData[idx + 2] = hv;
            dispData[idx + 3] = 255;

            // 2. DIFF (Albedo)
            const cNoise = (colorNoise2D(x * texParams.colorNoiseFreq, y * texParams.colorNoiseFreq) + 1) / 2;
            const v = (cNoise - 0.5) * texParams.colorVariation;
            diffData[idx] = Math.max(0, Math.min(255, (texParams.baseColor[0] + v) * 255));
            diffData[idx + 1] = Math.max(0, Math.min(255, (texParams.baseColor[1] + v) * 255));
            diffData[idx + 2] = Math.max(0, Math.min(255, (texParams.baseColor[2] + v) * 255));
            diffData[idx + 3] = 255;

            // 3. ARM (AO, Roughness, Metallic)
            // AO derived from height (lower is darker)
            const ao = Math.max(0, Math.min(255, (h * 0.5 + 0.5) * texParams.aoStrength * 255));
            armData[idx] = ao; // R: AO
            armData[idx + 1] = texParams.roughness * 255; // G: Roughness
            armData[idx + 2] = texParams.metallic * 255; // B: Metallic
            armData[idx + 3] = 255;

            // 4. NOR_GL (Normal Map)
            // Sobel or central difference
            const hL = getHeight(x - 1, y);
            const hR = getHeight(x + 1, y);
            const hU = getHeight(x, y - 1);
            const hD = getHeight(x, y + 1);

            const nx = (hL - hR) * texParams.normalStrength;
            const ny = (hU - hD) * texParams.normalStrength;
            const nz = 1.0;

            // Normalize
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            const nux = nx / len;
            const nuy = ny / len;
            const nuz = nz / len;

            norData[idx] = Math.floor((nux * 0.5 + 0.5) * 255);
            norData[idx + 1] = Math.floor((nuy * 0.5 + 0.5) * 255);
            norData[idx + 2] = Math.floor((nuz * 0.5 + 0.5) * 255);
            norData[idx + 3] = 255;
        }
    }

    const prefix = `proc_${texParams.seed}`;
    addon.IO.saveImage(`${prefix}_diff.png`, res, res, diffData);
    addon.IO.saveImage(`${prefix}_disp.png`, res, res, dispData);
    addon.IO.saveImage(`${prefix}_nor_gl.png`, res, res, norData);
    addon.IO.saveImage(`${prefix}_arm.png`, res, res, armData);

    Entropy.println(`Saved textures as ${prefix}_*.png in project textures directory.`);
}

addon.onInit(async () => {
    Entropy.println("PBR Texture Designer Initializing...");

    const savedData = addon.IO.load();
    if (savedData) {
        texParams = { ...texParams, ...savedData };
    }

    const renderUI = (tab: string) => {
        Entropy.UI.Widget.label(tab, { text: "🎨 PBR Texture Designer", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "💾 Save Parameters",
            onClick: () => {
                addon.IO.save(texParams);
                Entropy.println("PBR Texture settings saved!");
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🚀 GENERATE & SAVE PNGs",
            onClick: () => {
                saveTextures();
            }
        });

        Entropy.UI.Widget.label(tab, { text: "📐 Core Settings", bold: true });
        Entropy.UI.Widget.numericInput(tab, {
            label: "Seed",
            value: texParams.seed,
            onChange: (val) => { texParams.seed = parseInt(val); }
        });

        Entropy.UI.Widget.dropdown(tab, {
            label: "Resolution",
            options: ["256", "512", "1024", "2048"],
            selectedIndex: ["256", "512", "1024", "2048"].indexOf(texParams.resolution.toString()),
            onChange: (idx) => { 
                const resMap = [256, 512, 1024, 2048];
                texParams.resolution = resMap[parseInt(idx)];
            }
        });

        Entropy.UI.Widget.label(tab, { text: "🎨 Albedo (Diffuse)", bold: true });
        Entropy.UI.Widget.colorInput(tab, {
            label: "Base Color",
            color: texParams.baseColor,
            onChange: (c) => { texParams.baseColor = c; }
        });
        Entropy.UI.Widget.slider(tab, {
            label: "Color Variation",
            value: texParams.colorVariation,
            min: 0, max: 1,
            onChange: (v) => { texParams.colorVariation = parseFloat(v); }
        });

        Entropy.UI.Widget.label(tab, { text: "⛰️ Height & Normals", bold: true });
        Entropy.UI.Widget.slider(tab, {
            label: "Height Frequency",
            value: texParams.heightFrequency,
            min: 0.001, max: 0.1,
            onChange: (v) => { texParams.heightFrequency = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(tab, {
            label: "Normal Strength",
            value: texParams.normalStrength,
            min: 0.1, max: 20.0,
            onChange: (v) => { texParams.normalStrength = parseFloat(v); }
        });

        Entropy.UI.Widget.label(tab, { text: "💎 Material (ARM)", bold: true });
        Entropy.UI.Widget.slider(tab, {
            label: "Roughness",
            value: texParams.roughness,
            min: 0, max: 1,
            onChange: (v) => { texParams.roughness = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(tab, {
            label: "Metallic",
            value: texParams.metallic,
            min: 0, max: 1,
            onChange: (v) => { texParams.metallic = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(tab, {
            label: "AO Strength",
            value: texParams.aoStrength,
            min: 0, max: 1,
            onChange: (v) => { texParams.aoStrength = parseFloat(v); }
        });

        Entropy.UI.Widget.label(tab, { text: "🎭 Presets", bold: true });
        Entropy.UI.Widget.button(tab, {
            text: "🪨 Dark Rock",
            onClick: () => {
                texParams.baseColor = [0.2, 0.2, 0.22, 1.0];
                texParams.roughness = 0.9;
                texParams.heightFrequency = 0.04;
                texParams.normalStrength = 15.0;
                Entropy.println("Preset: Dark Rock loaded");
            }
        });
        Entropy.UI.Widget.button(tab, {
            text: "🍦 Smooth Sand",
            onClick: () => {
                texParams.baseColor = [0.9, 0.8, 0.6, 1.0];
                texParams.roughness = 0.7;
                texParams.heightFrequency = 0.01;
                texParams.normalStrength = 3.0;
                Entropy.println("Preset: Smooth Sand loaded");
            }
        });
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("PBR Texture Designer", renderUI);
    }

    const tab = addon.UI.createTab({
        title: "Texture Designer",
        onRender: async () => {
            renderUI(tab);
        }
    });
});
