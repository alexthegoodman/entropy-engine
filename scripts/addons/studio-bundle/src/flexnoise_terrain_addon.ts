// Terrain Generation Addon
// Demonstrates procedural heightmap generation in JavaScript
// Heights are generated JS-side and passed to Rust for rendering

// Simple Simplex Noise implementation (no dependencies needed)
class SimplexNoise {
    public seed: number;
    public grad3: number[][];
    public p: number[];
    public perm: number[];

    constructor(seed = 0) {
        this.seed = seed;
        this.grad3 = [
            [1,1,0], [-1,1,0], [1,-1,0], [-1,-1,0],
            [1,0,1], [-1,0,1], [1,0,-1], [-1,0,-1],
            [0,1,1], [0,-1,1], [0,1,-1], [0,-1,-1]
        ];
        this.p = [];
        for (let i = 0; i < 256; i++) {
            this.p[i] = Math.floor(this.seededRandom(i) * 256);
        }
        this.perm = [];
        for (let i = 0; i < 512; i++) {
            this.perm[i] = this.p[i & 255];
        }
    }

    seededRandom(i: number) {
        const x = Math.sin(i + this.seed) * 10000;
        return x - Math.floor(x);
    }

    dot(g: number[], x: number, y: number) {
        return g[0] * x + g[1] * y;
    }

    noise2D(xin: number, yin: number) {
        const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
        const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;

        let n0, n1, n2;
        const s = (xin + yin) * F2;
        const i = Math.floor(xin + s);
        const j = Math.floor(yin + s);
        const t = (i + j) * G2;
        const X0 = i - t;
        const Y0 = j - t;
        const x0 = xin - X0;
        const y0 = yin - Y0;

        let i1, j1;
        if (x0 > y0) { i1 = 1; j1 = 0; } 
        else { i1 = 0; j1 = 1; }

        const x1 = x0 - i1 + G2;
        const y1 = y0 - j1 + G2;
        const x2 = x0 - 1.0 + 2.0 * G2;
        const y2 = y0 - 1.0 + 2.0 * G2;

        const ii = i & 255;
        const jj = j & 255;
        const gi0 = this.perm[ii + this.perm[jj]] % 12;
        const gi1 = this.perm[ii + i1 + this.perm[jj + j1]] % 12;
        const gi2 = this.perm[ii + 1 + this.perm[jj + 1]] % 12;

        let t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 < 0) n0 = 0.0;
        else {
            t0 *= t0;
            n0 = t0 * t0 * this.dot(this.grad3[gi0], x0, y0);
        }

        let t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 < 0) n1 = 0.0;
        else {
            t1 *= t1;
            n1 = t1 * t1 * this.dot(this.grad3[gi1], x1, y1);
        }

        let t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 < 0) n2 = 0.0;
        else {
            t2 *= t2;
            n2 = t2 * t2 * this.dot(this.grad3[gi2], x2, y2);
        }

        return 70.0 * (n0 + n1 + n2);
    }
}

// FBM (Fractional Brownian Motion) implementation
function fbm(noise: SimplexNoise, x: number, y: number, octaves: number, frequency: number, persistence: number, lacunarity: number) {
    let total = 0;
    let amplitude = 1;
    let maxValue = 0;
    let freq = frequency;

    for (let i = 0; i < octaves; i++) {
        total += noise.noise2D(x * freq, y * freq) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        freq *= lacunarity;
    }

    return total / maxValue;
}

const addon = Entropy.Addon.register({
    name: "FlexNoise Terrain",
    version: "3.0.0",
    description: "Highly customizable procedural terrain with JS-side noise and UI controls",
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
    pipelineId: null
};

async function generateTerrain() {
    Entropy.println(`Regenerating FlexNoise Terrain: ${terrainParams.width}x${terrainParams.height}...`);
    
    const noise = new SimplexNoise(terrainParams.seed);
    const heights = [];
    
    for (let y = 0; y < terrainParams.height; y++) {
        for (let x = 0; x < terrainParams.width; x++) {
            const noiseValue = fbm(
                noise,
                x, y,
                terrainParams.octaves,
                terrainParams.frequency,
                terrainParams.persistence,
                terrainParams.lacunarity
            );
            
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
    Entropy.println("FlexNoise Terrain Addon Initializing...");

    // Initial Load
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
            text: "🎲 Randomize Seed",
            onClick: () => {
                terrainParams.seed = Math.floor(Math.random() * 10000);
                generateTerrain();
            }
        });

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

    generateTerrain();

    const tab = addon.UI.createTab({
        title: "FlexNoise",
        onRender: async () => {
            renderTerrainUI(tab);
        }
    });
});
