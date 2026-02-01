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

const addon = await Entropy.Addon.register({
    name: "Procedural Terrain",
    version: "2.0.0",
    description: "Generates terrain using JS-side noise (height data passed to Rust)",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let terrainParams = {
    seed: Math.floor(Math.random() * 1000),
    frequency: 0.005,
    octaves: 6,
    persistence: 0.5,
    lacunarity: 2.0,
    usePBR: true,
    width: 128,
    height: 128,
    heightScale: 2.0
};

async function generateTerrain() {
  // TODO: performance.now() is not currently exposed to via addon sdk
    // const startTime = performance.now();
    
    // 1. Generate heights on JS side
    Entropy.println(`Generating ${terrainParams.width}x${terrainParams.height} heightmap in JavaScript...`);
    
    const noise = new SimplexNoise(terrainParams.seed);
    const heights = [];
    const totalPoints = terrainParams.width * terrainParams.height;
    
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
            
            // Scale and offset the height
            const height = noiseValue * terrainParams.heightScale;
            heights.push(height);
        }
    }
    
    // const genTime = performance.now() - startTime;
    Entropy.println(`Generated ${totalPoints} height values in N/A ms`);
    Entropy.println(`Data size: ${(heights.length * 4 / 1024).toFixed(2)} KB (assuming f32)`);

    // 2. Create pipeline if needed
    let pipelineId = "default";
    if (!terrainParams.usePBR) {
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

    // 3. Pass heights array to Rust (no noiseId - data is JS-generated!)
    // const uploadStart = performance.now();
    addon.Landscape.create({
        width: terrainParams.width,
        height: terrainParams.height,
        heights: heights,  // Pass JS-generated heights!
        noiseId: null,     // Not using Rust-side noise
        position: [0, 0, 0],
        pipelineId: pipelineId
    });
    // const uploadTime = performance.now() - uploadStart;
    
    // Entropy.println(`Uploaded to Rust in ${uploadTime.toFixed(2)}ms`);
    // Entropy.println(`Total time: ${(genTime + uploadTime).toFixed(2)}ms`);
}

addon.onInit(async () => {
    Entropy.println("Procedural Terrain (JS-side generation) Initializing...");

    generateTerrain();

    // Tab 1
    const tab1 = Entropy.UI.createTab({
        title: "Noise Settings",
        onRender: async () => {
            // render callback
            // Entropy.println("onRender: " + tab1);

            Entropy.UI.Widget.label(tab1, { text: "Terrain Generation (JS-side)", bold: true });
            Entropy.UI.Widget.label(tab1, { text: "" }); // Spacer
            Entropy.UI.Widget.label(tab1, { text: "Current Settings", bold: true });
            Entropy.UI.Widget.label(tab1, { text: `Seed: ${terrainParams.seed}` });
            Entropy.UI.Widget.label(tab1, { 
                text: `Resolution: ${terrainParams.width}x${terrainParams.height}` 
            });
            Entropy.UI.Widget.label(tab1, { 
                text: `Points: ${terrainParams.width * terrainParams.height}` 
            });
            Entropy.UI.Widget.label(tab1, { text: `Octaves: ${terrainParams.octaves}` });
            Entropy.UI.Widget.label(tab1, { text: `Frequency: ${terrainParams.frequency}` });
            Entropy.UI.Widget.label(tab1, { 
                text: `Mode: ${terrainParams.usePBR ? "PBR" : "Non-PBR"}` 
            });

            // Entropy.println("onRender 2: " + tab1);
            
            // TODO: buttons not rendering
            Entropy.UI.Widget.button(tab1, {
                text: "🎲 Randomize Seed & Regenerate",
                onClick: () => {
                    terrainParams.seed = Math.floor(Math.random() * 1000);
                    generateTerrain();
                }
            });

            Entropy.UI.Widget.button(tab1, {
                text: terrainParams.usePBR ? "🎨 Switch to non-PBR (Green)" : "✨ Switch to PBR",
                onClick: () => {
                    terrainParams.usePBR = !terrainParams.usePBR;
                    generateTerrain();
                }
            });

            Entropy.UI.Widget.button(tab1, {
                text: "📈 Increase Resolution (256x256)",
                onClick: () => {
                    terrainParams.width = 256;
                    terrainParams.height = 256;
                    generateTerrain();
                }
            });

            Entropy.UI.Widget.button(tab1, {
                text: "📉 Decrease Resolution (64x64)",
                onClick: () => {
                    terrainParams.width = 64;
                    terrainParams.height = 64;
                    generateTerrain();
                }
            });

            Entropy.UI.Widget.button(tab1, {
                text: "🔄 Reset to Default (128x128)",
                onClick: () => {
                    terrainParams.width = 128;
                    terrainParams.height = 128;
                    generateTerrain();
                }
            });
        }
    });

    
});