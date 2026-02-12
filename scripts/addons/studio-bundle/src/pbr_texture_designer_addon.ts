import { createNoise2D } from 'simplex-noise';
import Alea from 'alea';

const addonInfo = {
    name: "PBR Texture Designer Pro",
    version: "2.0.0",
    description: "Procedural PBR Texture Generator with Multiple Pattern Types",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

const PREVIEW_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct MeshUniforms {
    model_matrix: mat4x4<f32>,
};
@group(1) @binding(0)
var<uniform> mesh: MeshUniforms;

struct PreviewParams {
    seed: f32,
    base_color: vec4<f32>,
    params1: vec4<f32>, // x: roughness, y: metallic, z: ao_strength, w: normal_strength
}
@group(2) @binding(0)
var<uniform> p: PreviewParams;

@group(2) @binding(1)
var t_diffuse: texture_2d<f32>;
@group(2) @binding(2)
var s_diffuse: sampler;
@group(2) @binding(3)
var t_normal: texture_2d<f32>;
@group(2) @binding(4)
var t_arm: texture_2d<f32>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) normal: vec3<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let world_pos = mesh.model_matrix * vec4<f32>(in.position, 1.0);
    out.world_pos = world_pos.xyz;
    out.clip_position = camera.view_proj * world_pos;
    out.uv = in.uv;
    out.normal = (mesh.model_matrix * vec4<f32>(in.normal, 0.0)).xyz;
    return out;
}

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    let albedo = textureSample(t_diffuse, s_diffuse, in.uv);
    let normal_map = textureSample(t_normal, s_diffuse, in.uv).rgb * 2.0 - 1.0;
    let arm1 = textureSample(t_arm, s_diffuse, in.uv);
    let arm = vec4<f32>(arm1.x, arm1.y, 0.35, 1.0);
    
    var out: GbufferOutput;
    out.position = vec4<f32>(in.world_pos, 1.0);
    out.normal = vec4<f32>(normalize(in.normal + normal_map * 0.5), 1.0);
    out.albedo = albedo;
    out.pbr_material = arm;
    return out;
}
`;

type PatternType = 'noise' | 'wood_grain' | 'marble' | 'brick' | 'hex_tiles' | 'scales' | 'fabric' | 'rust';

let texParams = {
    seed: 1234,
    resolution: 512,
    previewRes: 128,
    
    // Pattern Selection
    patternType: 'noise' as PatternType,
    patternScale: 1.0,
    
    // Colors
    baseColor: [0.5, 0.4, 0.3, 1.0],
    secondaryColor: [0.3, 0.2, 0.15, 1.0],
    tertiaryColor: [0.7, 0.6, 0.5, 1.0],
    
    // Material Properties
    roughness: 0.8,
    metallic: 0.0,
    aoStrength: 1.0,
    
    // Height & Normals
    heightFrequency: 0.02,
    heightOctaves: 4,
    heightPersistence: 0.5,
    heightLacunarity: 2.0,
    normalStrength: 10.0,
    
    // Color Variation (for noise-based patterns)
    colorVariation: 0.1,
    colorNoiseFreq: 0.05,
    
    // Pattern-Specific Parameters
    woodRingFrequency: 0.3,
    woodGrainTurbulence: 2.0,
    woodGrainStretch: 3.0,
    marbleVeinFrequency: 0.02,
    marbleVeinContrast: 0.8,
    marbleTurbulence: 3.0,
    brickWidth: 64,
    brickHeight: 32,
    mortarWidth: 4,
    brickVariation: 0.15,
    hexSize: 40.0,
    hexGroutWidth: 3.0,
    hexVariation: 0.1,
    scaleSize: 30.0,
    scaleRoughness: 0.3,
    scaleOverlap: 0.15,
    warpFrequency: 0.1,
    weftFrequency: 0.1,
    weaveIntensity: 0.5,
    rustCoverage: 0.4,
    rustSpotSize: 0.05,
    rustDepth: 0.6,
    
    previewRotation: [0.0, 0.0, 0.0],
    pipelineId: null as string | null
};

let addonState = {
    savedComponents: [
        { id: Entropy.generateUUID(), name: "Default Texture", params: JSON.parse(JSON.stringify(texParams)) }
    ] as { id: string, name: string, params: typeof texParams }[],
    activeComponentId: "",
    get currentParams(): typeof texParams {
        const found = this.savedComponents.find(c => c.id === this.activeComponentId);
        return found ? found.params : this.savedComponents[0].params;
    },
    set currentParams(val: typeof texParams) {
        const found = this.savedComponents.find(c => c.id === this.activeComponentId);
        if (found) {
            found.params = val;
        } else {
            this.savedComponents[0].params = val;
        }
    }
};
addonState.activeComponentId = addonState.savedComponents[0].id;

let newComponentName = "New Texture Component";

function generateCubeData() {
    // Format: position(3) + normal(3) + uv(2) + color(4) = 12 floats per vertex
    const vertices = [
        // Front face
        -1, -1,  1,  0, 0, 1,  0, 1,  1, 1, 1, 1,
         1, -1,  1,  0, 0, 1,  1, 1,  1, 1, 1, 1,
         1,  1,  1,  0, 0, 1,  1, 0,  1, 1, 1, 1,
        -1,  1,  1,  0, 0, 1,  0, 0,  1, 1, 1, 1,
        // Back face
        -1, -1, -1,  0, 0, -1,  1, 1,  1, 1, 1, 1,
        -1,  1, -1,  0, 0, -1,  1, 0,  1, 1, 1, 1,
         1,  1, -1,  0, 0, -1,  0, 0,  1, 1, 1, 1,
         1, -1, -1,  0, 0, -1,  0, 1,  1, 1, 1, 1,
        // Top face
        -1,  1, -1,  0, 1, 0,  0, 0,  1, 1, 1, 1,
        -1,  1,  1,  0, 1, 0,  0, 1,  1, 1, 1, 1,
         1,  1,  1,  0, 1, 0,  1, 1,  1, 1, 1, 1,
         1,  1, -1,  0, 1, 0,  1, 0,  1, 1, 1, 1,
        // Bottom face
        -1, -1, -1,  0, -1, 0,  1, 0,  1, 1, 1, 1,
         1, -1, -1,  0, -1, 0,  0, 0,  1, 1, 1, 1,
         1, -1,  1,  0, -1, 0,  0, 1,  1, 1, 1, 1,
        -1, -1,  1,  0, -1, 0,  1, 1,  1, 1, 1, 1,
        // Right face
         1, -1, -1,  1, 0, 0,  1, 1,  1, 1, 1, 1,
         1,  1, -1,  1, 0, 0,  1, 0,  1, 1, 1, 1,
         1,  1,  1,  1, 0, 0,  0, 0,  1, 1, 1, 1,
         1, -1,  1,  1, 0, 0,  0, 1,  1, 1, 1, 1,
        // Left face
        -1, -1, -1, -1, 0, 0,  0, 1,  1, 1, 1, 1,
        -1, -1,  1, -1, 0, 0,  1, 1,  1, 1, 1, 1,
        -1,  1,  1, -1, 0, 0,  1, 0,  1, 1, 1, 1,
        -1,  1, -1, -1, 0, 0,  0, 0,  1, 1, 1, 1,
    ];
    const indices = [
        0, 1, 2, 0, 2, 3,
        4, 5, 6, 4, 6, 7,
        8, 9, 10, 8, 10, 11,
        12, 13, 14, 12, 14, 15,
        16, 17, 18, 16, 18, 19,
        20, 21, 22, 20, 22, 23,
    ];
    return { vertices, indices };
}

// Helper: Linear interpolation between colors
function lerpColor(c1: number[], c2: number[], t: number): number[] {
    return [
        c1[0] + (c2[0] - c1[0]) * t,
        c1[1] + (c2[1] - c1[1]) * t,
        c1[2] + (c2[2] - c1[2]) * t,
        c1[3] + (c2[3] - c1[3]) * t
    ];
}

// Helper: Clamp value between 0 and 1
function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

// ============= PATTERN GENERATORS =============

function generateNoisePattern(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const v = (colorNoise2D(x * addonState.currentParams.colorNoiseFreq * scale, y * addonState.currentParams.colorNoiseFreq * scale) - 0.5) * addonState.currentParams.colorVariation;
    
    return {
        color: [
            addonState.currentParams.baseColor[0] + v,
            addonState.currentParams.baseColor[1] + v,
            addonState.currentParams.baseColor[2] + v,
            addonState.currentParams.baseColor[3]
        ],
        height: 0.5
    };
}

function generateWoodGrain(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const centerX = 256;
    const centerY = 256;
    const sx = (x - centerX) / scale;
    const sy = (y - centerY) / scale / addonState.currentParams.woodGrainStretch;
    const dist = Math.sqrt(sx * sx + sy * sy);
    const turbulence = noise2D(x * 0.01 * scale, y * 0.01 * scale) * addonState.currentParams.woodGrainTurbulence;
    const ringPattern = Math.sin((dist + turbulence) * addonState.currentParams.woodRingFrequency);
    const grainNoise = noise2D(x * 0.02 * scale, y * 0.05 * scale);
    const woodValue = (ringPattern + 1) / 2 * 0.7 + grainNoise * 0.3;
    const color = lerpColor(addonState.currentParams.secondaryColor, addonState.currentParams.tertiaryColor, woodValue);
    return { color: color, height: woodValue };
}

function generateMarble(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const warp1 = noise2D(x * addonState.currentParams.marbleVeinFrequency * scale, y * addonState.currentParams.marbleVeinFrequency * scale) * addonState.currentParams.marbleTurbulence;
    const warp2 = noise2D((x + 100) * addonState.currentParams.marbleVeinFrequency * scale, (y + 100) * addonState.currentParams.marbleVeinFrequency * scale) * addonState.currentParams.marbleTurbulence;
    const veinX = x + warp1 * 50;
    const veinY = y + warp2 * 50;
    const veinPattern = Math.sin(veinX * 0.05 * scale) * Math.cos(veinY * 0.05 * scale);
    const detailNoise = noise2D(x * 0.1 * scale, y * 0.1 * scale) * 0.2;
    const marbleValue = (veinPattern + 1) / 2 * addonState.currentParams.marbleVeinContrast + detailNoise;
    const normalizedValue = clamp01(marbleValue);
    let color;
    if (normalizedValue > 0.6) {
        color = lerpColor(addonState.currentParams.baseColor, addonState.currentParams.tertiaryColor, (normalizedValue - 0.6) * 2.5);
    } else {
        color = lerpColor(addonState.currentParams.secondaryColor, addonState.currentParams.baseColor, normalizedValue / 0.6);
    }
    return { color: color, height: normalizedValue * 0.3 + 0.35 };
}

function generateBrick(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const brickW = addonState.currentParams.brickWidth / scale;
    const brickH = addonState.currentParams.brickHeight / scale;
    const mortarW = addonState.currentParams.mortarWidth / scale;
    const row = Math.floor(y / brickH);
    const offsetX = (row % 2) * (brickW / 2);
    const localX = (x + offsetX) % brickW;
    const localY = y % brickH;
    const isMortar = localX < mortarW || localY < mortarW;
    if (isMortar) {
        return { color: addonState.currentParams.secondaryColor, height: 0.2 };
    } else {
        const brickId = Math.floor((x + offsetX) / brickW) + Math.floor(y / brickH) * 1000;
        const brickNoise = (noise2D(brickId * 0.1, brickId * 0.2) + 1) / 2;
        const variation = (brickNoise - 0.5) * addonState.currentParams.brickVariation;
        const color = lerpColor(addonState.currentParams.baseColor, addonState.currentParams.tertiaryColor, 0.5 + variation);
        const surfaceNoise = noise2D(x * 0.1 * scale, y * 0.1 * scale) * 0.1;
        return { color: color, height: 0.6 + surfaceNoise };
    }
}

function generateHexTiles(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const size = addonState.currentParams.hexSize / scale;
    const grout = addonState.currentParams.hexGroutWidth / scale;
    const sqrt3 = Math.sqrt(3);
    const hexWidth = size * 2;
    const hexHeight = size * sqrt3;
    const col = Math.floor(x / (hexWidth * 0.75));
    const row = Math.floor(y / hexHeight);
    const yOffset = (col % 2) * (hexHeight / 2);
    const localX = x - col * (hexWidth * 0.75);
    const localY = y - row * hexHeight - yOffset;
    const dx = localX - hexWidth / 2;
    const dy = localY - hexHeight / 2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const isGrout = dist > (size - grout);
    if (isGrout) {
        return { color: addonState.currentParams.secondaryColor, height: 0.15 };
    } else {
        const tileId = col + row * 1000;
        const tileNoise = (noise2D(tileId * 0.1, tileId * 0.15) + 1) / 2;
        const variation = (tileNoise - 0.5) * addonState.currentParams.hexVariation;
        const color = lerpColor(lerpColor(addonState.currentParams.baseColor, addonState.currentParams.tertiaryColor, 0.5), addonState.currentParams.baseColor, variation);
        return { color: color, height: 0.5 + tileNoise * 0.1 };
    }
}

function generateScales(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const size = addonState.currentParams.scaleSize / scale;
    const overlap = addonState.currentParams.scaleOverlap;
    const row = Math.floor(y / (size * (1 - overlap)));
    const col = Math.floor(x / size);
    const offsetX = (row % 2) * (size / 2);
    const localX = (x - offsetX) % size;
    const localY = y % (size * (1 - overlap));
    const dx = (localX - size / 2) / (size / 2);
    const dy = (localY - size * (1 - overlap) / 2) / (size * (1 - overlap) / 2);
    const distSq = dx * dx + dy * dy;
    const scaleId = col + row * 1000;
    const scaleNoise = (noise2D(scaleId * 0.2, scaleId * 0.3) + 1) / 2;
    let height = 0.5;
    let color;
    if (distSq < 0.8) {
        const edgeDist = Math.sqrt(distSq);
        height = 0.7 - edgeDist * 0.3;
        color = lerpColor(addonState.currentParams.baseColor, addonState.currentParams.tertiaryColor, scaleNoise);
        const detailNoise = noise2D(x * 0.2 * scale, y * 0.2 * scale);
        color = color.map((c, i) => i < 3 ? clamp01(c + detailNoise * addonState.currentParams.scaleRoughness * 0.2) : c);
    } else {
        color = addonState.currentParams.secondaryColor;
        height = 0.3;
    }
    return { color, height };
}

function generateFabric(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const warpFreq = addonState.currentParams.warpFrequency * scale;
    const weftFreq = addonState.currentParams.weftFrequency * scale;
    const warp = Math.sin(x * warpFreq) * addonState.currentParams.weaveIntensity;
    const weft = Math.sin(y * weftFreq) * addonState.currentParams.weaveIntensity;
    const weavePattern = (warp + weft + 2) / 4;
    const fabricNoise = noise2D(x * 0.1 * scale, y * 0.1 * scale) * 0.2;
    const fabricValue = weavePattern + fabricNoise;
    let color;
    if (fabricValue > 0.6) {
        color = lerpColor(addonState.currentParams.baseColor, addonState.currentParams.tertiaryColor, (fabricValue - 0.6) * 2.5);
    } else {
        color = lerpColor(addonState.currentParams.secondaryColor, addonState.currentParams.baseColor, fabricValue / 0.6);
    }
    return { color: color, height: 0.4 + weavePattern * 0.2 };
}

function generateRust(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const metalNoise = (noise2D(x * 0.05 * scale, y * 0.05 * scale) + 1) / 2;
    const rustNoise1 = (noise2D(x * addonState.currentParams.rustSpotSize * scale, y * addonState.currentParams.rustSpotSize * scale) + 1) / 2;
    const rustNoise2 = (noise2D(x * addonState.currentParams.rustSpotSize * 2 * scale, y * addonState.currentParams.rustSpotSize * 2 * scale) + 1) / 2;
    const rustAmount = (rustNoise1 * 0.7 + rustNoise2 * 0.3);
    const isRusted = rustAmount < addonState.currentParams.rustCoverage;
    let color;
    let height;
    if (isRusted) {
        const rustIntensity = rustAmount / addonState.currentParams.rustCoverage;
        if (rustIntensity < 0.3) {
            color = lerpColor(addonState.currentParams.secondaryColor, addonState.currentParams.baseColor, rustIntensity / 0.3);
        } else {
            color = lerpColor(addonState.currentParams.baseColor, addonState.currentParams.tertiaryColor, (rustIntensity - 0.3) / 0.7);
        }
        height = 0.3 + rustAmount * 0.3;
    } else {
        color = lerpColor(addonState.currentParams.tertiaryColor, addonState.currentParams.baseColor, metalNoise * 0.3);
        height = 0.6 + metalNoise * 0.2;
    }
    return { color, height };
}

// ============= TEXTURE GENERATION =============

function generateTextures(resolution: number) {
    const res = resolution;
    const prng = Alea(addonState.currentParams.seed);
    const noise2D = createNoise2D(prng);
    const colorPrng = Alea(addonState.currentParams.seed + 1);
    const colorNoise2D = createNoise2D(colorPrng);

    const diffData = new Uint8Array(res * res * 4);
    const norData = new Uint8Array(res * res * 4);
    const armData = new Uint8Array(res * res * 4);

    const scale = addonState.currentParams.patternScale;

    // Select pattern generator
    let patternGenerator: (x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) => {color: number[], height: number};
    
    switch (addonState.currentParams.patternType) {
        case 'wood_grain': patternGenerator = generateWoodGrain; break;
        case 'marble': patternGenerator = generateMarble; break;
        case 'brick': patternGenerator = generateBrick; break;
        case 'hex_tiles': patternGenerator = generateHexTiles; break;
        case 'scales': patternGenerator = generateScales; break;
        case 'fabric': patternGenerator = generateFabric; break;
        case 'rust': patternGenerator = generateRust; break;
        default: patternGenerator = generateNoisePattern;
    }

    const heightMap: number[][] = [];
    for (let y = 0; y < res; y++) {
        heightMap[y] = [];
        for (let x = 0; x < res; x++) {
            const result = patternGenerator(x, y, noise2D, colorNoise2D, scale);
            heightMap[y][x] = result.height;
        }
    }

    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            const idx = (y * res + x) * 4;
            const result = patternGenerator(x, y, noise2D, colorNoise2D, scale);
            const h = result.height;

            diffData[idx] = Math.max(0, Math.min(255, result.color[0] * 255));
            diffData[idx + 1] = Math.max(0, Math.min(255, result.color[1] * 255));
            diffData[idx + 2] = Math.max(0, Math.min(255, result.color[2] * 255));
            diffData[idx + 3] = 255;

            const ao = Math.max(0, Math.min(255, (h * 0.5 + 0.5) * addonState.currentParams.aoStrength * 255));
            armData[idx] = ao;
            armData[idx + 1] = addonState.currentParams.roughness * 255;
            armData[idx + 2] = addonState.currentParams.metallic * 255;
            armData[idx + 3] = 255;

            const hL = heightMap[y][Math.max(0, x - 1)];
            const hR = heightMap[y][Math.min(res - 1, x + 1)];
            const hU = heightMap[Math.max(0, y - 1)][x];
            const hD = heightMap[Math.min(res - 1, y + 1)][x];
            const nx = (hL - hR) * addonState.currentParams.normalStrength;
            const ny = (hU - hD) * addonState.currentParams.normalStrength;
            const nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            norData[idx] = Math.floor((nx / len * 0.5 + 0.5) * 255);
            norData[idx + 1] = Math.floor((ny / len * 0.5 + 0.5) * 255);
            norData[idx + 2] = Math.floor((nz / len * 0.5 + 0.5) * 255);
            norData[idx + 3] = 255;
        }
    }
    return { diffData, norData, armData };
}

function generatePBRTextures(id: string, params: typeof texParams, resolution: number) {
    const { diffData, norData, armData } = generateTextures(resolution);
    const diffId = addon.Texture.create(resolution, resolution, diffData);
    const norId = addon.Texture.create(resolution, resolution, norData);
    const armId = addon.Texture.create(resolution, resolution, armData);

    if (!globalThis.lastPBRDesignerTextures) {
        globalThis.lastPBRDesignerTextures = {};
    }

    globalThis.lastPBRDesignerTextures[id] = { diffId, norId, armId, params: { ...params } };
    if (typeof globalThis.onPBRDesignerUpdate === 'function') globalThis.onPBRDesignerUpdate();

    return { diffId, norId, armId };
}

function updatePreview(params: typeof texParams, id: string = "default") {
    if (!params.pipelineId) return;
    
    const { diffId, norId, armId } = generatePBRTextures(id, params, params.previewRes);

    const { vertices, indices } = generateCubeData();

    Entropy.println("PBR updatePreview");

    addon.Model.clearMeshes();
    addon.Model.createMesh({
        id: id,
        pipelineId: params.pipelineId,
        position: [-2, 0, -2],
        rotation: params.previewRotation,
        scale: [2, 2, 2],
        vertexData: vertices,
        indexData: indices,
        renderRole: "General",
        bindings: [
            { group: 2, binding: 0, resource: { type: "Uniform", value: { data: [params.seed, 0, 0, 0, ...params.baseColor, params.roughness, params.metallic, params.aoStrength, params.normalStrength] } } },
            { group: 2, binding: 1, resource: { type: "Texture", value: {id: diffId} } },
            { group: 2, binding: 2, resource: { type: "Sampler" } },
            { group: 2, binding: 3, resource: { type: "Texture", value: {id: norId} } },
            { group: 2, binding: 4, resource: { type: "Texture", value: {id: armId} } }
        ]
    });
}

function saveTextures(params: typeof texParams) {
    const res = params.resolution;
    const { diffData, norData, armData } = generateTextures(res);
    const prefix = `${params.patternType}_${params.seed}`;
    addon.IO.saveImage(`${prefix}_diff.png`, res, res, diffData);
    addon.IO.saveImage(`${prefix}_nor_gl.png`, res, res, norData);
    addon.IO.saveImage(`${prefix}_arm.png`, res, res, armData);
}

addon.onInit(async () => {
    const pipelineId = Entropy.Pipeline.create({
        name: "PBR_Preview_Pipeline",
        pbr: true,
        layout: "mesh",
        vertexShader: PREVIEW_SHADER,
        fragmentShader: PREVIEW_SHADER,
        extraBindGroups: [
            { entries: [
                { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
                { binding: 1, visibility: ["Fragment"], resourceType: "Texture" },
                { binding: 2, visibility: ["Fragment"], resourceType: "Sampler" },
                { binding: 3, visibility: ["Fragment"], resourceType: "Texture" },
                { binding: 4, visibility: ["Fragment"], resourceType: "Texture" }
            ]}
        ]
    });

    addonState.currentParams.pipelineId = pipelineId;
    // const savedData = addon.IO.load();
    // if (savedData) {
    //     addonState = { ...addonState, ...savedData };
    //     if (Entropy.Composer) {
    //         addonState.savedComponents.forEach(comp => {
    //             Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
    //         });
    //     }
    // }

    // Atmospheric lighting
    addon.Lighting.createPointLight({ position: [-3.0, 4.0, 5.0], color: [0.9, 0.9, 0.9], intensity: 8.0, maxDistance: 50.0 });
    addon.Lighting.createPointLight({ position: [3.0, 4.0, 10.0], color: [0.9, 0.9, 0.9], intensity: 8.0, maxDistance: 50.0 });
    addon.Lighting.createPointLight({ position: [0.0, 5.0, -10.0], color: [0.9, 0.9, 0.9], intensity: 8.0, maxDistance: 50.0 });

    updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());

    const renderUI = (tab: string) => {
        Entropy.Addon.setVisibility(addonInfo.name, true);
        Entropy.UI.Widget.label(tab, { text: "🎨 PBR Texture Designer Pro", bold: true });
        Entropy.UI.Widget.button(tab, { text: "💾 Save All to Project", onClick: () => {
            addon.IO.save(addonState);
            if (Entropy.Composer) {
                addonState.savedComponents.forEach(comp => { Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params); });
            }
        }});
        Entropy.UI.Widget.button(tab, { text: "🚀 GENERATE & SAVE PNGs", onClick: () => saveTextures(addonState.currentParams) });
        Entropy.UI.Widget.label(tab, { text: "📦 Components", bold: true });
        
        const activeComp = addonState.savedComponents.find(c => c.id === addonState.activeComponentId);
        if (activeComp) {
            Entropy.UI.Widget.button(tab, {
                text: `💾 Update "${activeComp.name}"`,
                onClick: () => {
                    addon.IO.save(addonState);
                    if (Entropy.Composer) {
                        Entropy.Composer.registerComponent(addonInfo.name, activeComp.id, activeComp.name, activeComp.params);
                    }
                    Entropy.println(`Updated component: ${activeComp.name}`);
                }
            });
        }

        Entropy.UI.Widget.button(tab, { text: "➕ Save Current as New Component", onClick: () => {
            const id = Math.random().toString(36).substr(2, 9);
            const name = `New Texture ${addonState.savedComponents.length + 1}`;
            addonState.savedComponents.push({ id, name: name, params: JSON.parse(JSON.stringify(addonState.currentParams)) });
            addonState.activeComponentId = id;
            if (Entropy.Composer) { Entropy.Composer!.registerComponent(addonInfo.name, id, name, addonState.currentParams); }
            addon.IO.save(addonState);
            Entropy.println(`Saved new component: ${name}`);
        }});
        addonState.savedComponents.forEach(comp => {
            Entropy.UI.Widget.button(tab, { text: `📂 Load & Render: ${comp.name}`, onClick: () => {
                addonState.activeComponentId = comp.id;
                updatePreview(addonState.currentParams, comp.id);
            }});
        });
        Entropy.UI.Widget.label(tab, { text: "--------------------------------" });
        Entropy.UI.Widget.label(tab, { text: "📐 Pattern Selection", bold: true });
        let patternOptions = ["noise", "wood_grain", "marble", "brick", "hex_tiles", "scales", "fabric", "rust"] as PatternType[];
        Entropy.UI.Widget.dropdown(tab, { label: "Pattern Type", options: patternOptions, selectedIndex: patternOptions.indexOf(addonState.currentParams.patternType), onChange: (val) => { addonState.currentParams.patternType = patternOptions[parseInt(val)]; updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.slider(tab, { label: "Pattern Scale", value: addonState.currentParams.patternScale, min: 0.1, max: 5.0, onChange: (v) => { addonState.currentParams.patternScale = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.label(tab, { text: "🎨 Colors", bold: true });
        Entropy.UI.Widget.colorInput(tab, { label: "Base Color", color: addonState.currentParams.baseColor, onChange: (c) => { addonState.currentParams.baseColor = c; updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.colorInput(tab, { label: "Secondary Color", color: addonState.currentParams.secondaryColor, onChange: (c) => { addonState.currentParams.secondaryColor = c; updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.colorInput(tab, { label: "Tertiary Color", color: addonState.currentParams.tertiaryColor, onChange: (c) => { addonState.currentParams.tertiaryColor = c; updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.label(tab, { text: "🔧 Core Settings", bold: true });
        Entropy.UI.Widget.numericInput(tab, { label: "Seed", value: addonState.currentParams.seed, onChange: (val) => { addonState.currentParams.seed = parseInt(val); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.slider(tab, { label: "Normal Strength", value: addonState.currentParams.normalStrength, min: 0.1, max: 20.0, onChange: (v) => { addonState.currentParams.normalStrength = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.label(tab, { text: "💎 Material (PBR)", bold: true });
        Entropy.UI.Widget.slider(tab, { label: "Roughness", value: addonState.currentParams.roughness, min: 0, max: 1, onChange: (v) => { addonState.currentParams.roughness = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        Entropy.UI.Widget.slider(tab, { label: "Metallic", value: addonState.currentParams.metallic, min: 0, max: 1, onChange: (v) => { addonState.currentParams.metallic = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        
        if (addonState.currentParams.patternType === 'wood_grain') {
            Entropy.UI.Widget.label(tab, { text: "🌲 Wood Grain Settings", bold: true });
            Entropy.UI.Widget.slider(tab, { label: "Ring Frequency", value: addonState.currentParams.woodRingFrequency, min: 0.1, max: 1.0, onChange: (v) => { addonState.currentParams.woodRingFrequency = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Grain Turbulence", value: addonState.currentParams.woodGrainTurbulence, min: 0.5, max: 5.0, onChange: (v) => { addonState.currentParams.woodGrainTurbulence = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Grain Stretch", value: addonState.currentParams.woodGrainStretch, min: 1.0, max: 5.0, onChange: (v) => { addonState.currentParams.woodGrainStretch = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        }
        if (addonState.currentParams.patternType === 'marble') {
            Entropy.UI.Widget.label(tab, { text: "⚪ Marble Settings", bold: true });
            Entropy.UI.Widget.slider(tab, { label: "Vein Frequency", value: addonState.currentParams.marbleVeinFrequency, min: 0.01, max: 0.1, onChange: (v) => { addonState.currentParams.marbleVeinFrequency = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Vein Contrast", value: addonState.currentParams.marbleVeinContrast, min: 0.1, max: 2.0, onChange: (v) => { addonState.currentParams.marbleVeinContrast = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Turbulence", value: addonState.currentParams.marbleTurbulence, min: 0.5, max: 10.0, onChange: (v) => { addonState.currentParams.marbleTurbulence = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        }
        if (addonState.currentParams.patternType === 'brick') {
            Entropy.UI.Widget.label(tab, { text: "🧱 Brick Settings", bold: true });
            Entropy.UI.Widget.slider(tab, { label: "Brick Width", value: addonState.currentParams.brickWidth, min: 20, max: 128, onChange: (v) => { addonState.currentParams.brickWidth = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Brick Height", value: addonState.currentParams.brickHeight, min: 10, max: 64, onChange: (v) => { addonState.currentParams.brickHeight = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Mortar Width", value: addonState.currentParams.mortarWidth, min: 1, max: 10, onChange: (v) => { addonState.currentParams.mortarWidth = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Brick Variation", value: addonState.currentParams.brickVariation, min: 0.0, max: 0.5, onChange: (v) => { addonState.currentParams.brickVariation = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        }
        if (addonState.currentParams.patternType === 'hex_tiles') {
            Entropy.UI.Widget.label(tab, { text: "⬡ Hex Tile Settings", bold: true });
            Entropy.UI.Widget.slider(tab, { label: "Hex Size", value: addonState.currentParams.hexSize, min: 10, max: 100, onChange: (v) => { addonState.currentParams.hexSize = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Grout Width", value: addonState.currentParams.hexGroutWidth, min: 1, max: 10, onChange: (v) => { addonState.currentParams.hexGroutWidth = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Tile Variation", value: addonState.currentParams.hexVariation, min: 0.0, max: 0.5, onChange: (v) => { addonState.currentParams.hexVariation = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        }
        if (addonState.currentParams.patternType === 'scales') {
            Entropy.UI.Widget.label(tab, { text: "🐉 Scale Settings", bold: true });
            Entropy.UI.Widget.slider(tab, { label: "Scale Size", value: addonState.currentParams.scaleSize, min: 10, max: 100, onChange: (v) => { addonState.currentParams.scaleSize = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Scale Overlap", value: addonState.currentParams.scaleOverlap, min: 0.0, max: 0.5, onChange: (v) => { addonState.currentParams.scaleOverlap = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Scale Roughness", value: addonState.currentParams.scaleRoughness, min: 0.0, max: 1.0, onChange: (v) => { addonState.currentParams.scaleRoughness = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        }
        if (addonState.currentParams.patternType === 'fabric') {
            Entropy.UI.Widget.label(tab, { text: "🧵 Fabric Settings", bold: true });
            Entropy.UI.Widget.slider(tab, { label: "Warp Frequency", value: addonState.currentParams.warpFrequency, min: 0.01, max: 0.5, onChange: (v) => { addonState.currentParams.warpFrequency = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Weft Frequency", value: addonState.currentParams.weftFrequency, min: 0.01, max: 0.5, onChange: (v) => { addonState.currentParams.weftFrequency = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Weave Intensity", value: addonState.currentParams.weaveIntensity, min: 0.1, max: 2.0, onChange: (v) => { addonState.currentParams.weaveIntensity = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        }
        if (addonState.currentParams.patternType === 'rust') {
            Entropy.UI.Widget.label(tab, { text: "🦀 Rust Settings", bold: true });
            Entropy.UI.Widget.slider(tab, { label: "Rust Coverage", value: addonState.currentParams.rustCoverage, min: 0.0, max: 1.0, onChange: (v) => { addonState.currentParams.rustCoverage = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Rust Spot Size", value: addonState.currentParams.rustSpotSize, min: 0.01, max: 0.2, onChange: (v) => { addonState.currentParams.rustSpotSize = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
            Entropy.UI.Widget.slider(tab, { label: "Rust Depth", value: addonState.currentParams.rustDepth, min: 0.0, max: 1.0, onChange: (v) => { addonState.currentParams.rustDepth = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
        }
        Entropy.UI.Widget.label(tab, { text: "🔄 Preview Rotation", bold: true });
        Entropy.UI.Widget.slider(tab, { label: "Rotation Y", value: addonState.currentParams.previewRotation[1], min: 0, max: 6.28, onChange: (v) => { addonState.currentParams.previewRotation[1] = parseFloat(v); updatePreview(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID()); } });
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor(addonInfo.name, renderUI);
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer(addonInfo.name, (id: string, params: any) => {
                updatePreview(params, id);
            });
        }
        if (Entropy.Composer) {
            Entropy.Composer.registerTextureGenerator(addonInfo.name, (id: string, params: any, res: number) => {
                return generatePBRTextures(id, params, res);
            });
        }
    }

    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            if (data.savedComponents) addonState.savedComponents = data.savedComponents;
            if (data.activeComponentId) addonState.activeComponentId = data.activeComponentId;

            // Register components with the composer
            if (Entropy.Composer) {
                addonState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                });
            }

            updatePreview(addonState.currentParams, addonState.activeComponentId);
        }
    });

    const tab = addon.UI.createTab({ title: "Texture Designer Pro", onRender: async () => renderUI(tab) });

    

    Entropy.println("✓ PBR Texture Designer Pro Initialized!");

    // --- Tools Registration ---

    const persistState = (newComponent = false) => {
        let id = addonState.activeComponentId;
        
        // persist state
        if (newComponent) {
            id = Entropy.generateUUID();

            addonState.savedComponents.push({
                id,
                name: newComponentName,
                params: JSON.parse(JSON.stringify(addonState.currentParams))
            });

            if (Entropy.Composer) {
                Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, addonState.currentParams);
            }
        }

        // at least, save the current state
        addon.IO.save(addonState);

        return id;
    }

    addon.registerTool({
        name: "create_pbr_texture",
        description: "Create a new procedural PBR texture component.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name for the new texture component" },
                patternType: { 
                    type: "string", 
                    enum: ["noise", "wood_grain", "marble", "brick", "hex_tiles", "scales", "fabric", "rust"],
                    description: "The base pattern type for the texture." 
                },
                baseColor: { 
                    type: "array", 
                    items: { type: "number" }, 
                    minItems: 3, 
                    maxItems: 4,
                    description: "Primary RGB(A) color [r, g, b, a?]" 
                },
                secondaryColor: {
                    type: "array", 
                    items: { type: "number" }, 
                    minItems: 3, 
                    maxItems: 4,
                    description: "Secondary RGB(A) color" 
                }
            },
            required: ["name", "patternType"]
        }
    }, (args: any) => {
        Entropy.println("Creating PBR texture via tool: " + JSON.stringify(args));
        
        const id = Entropy.generateUUID();
        const newParams = JSON.parse(JSON.stringify(texParams)); // Start with defaults
        
        newParams.patternType = args.patternType;
        if (args.baseColor) newParams.baseColor = args.baseColor.length === 3 ? [...args.baseColor, 1.0] : args.baseColor;
        if (args.secondaryColor) newParams.secondaryColor = args.secondaryColor.length === 3 ? [...args.secondaryColor, 1.0] : args.secondaryColor;

        addonState.savedComponents.push({ id, name: args.name, params: newParams });
        addonState.activeComponentId = id;
        addonState.currentParams = newParams;

        persistState(true);

        updatePreview(newParams, id);

        return { success: true, id: id, name: args.name, patternType: args.patternType };
    });

    addon.registerTool({
        name: "update_pbr_texture",
        description: "Update parameters of an existing or active PBR texture.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "ID of the texture to update. If omitted, updates the currently active texture." },
                patternScale: { type: "number", description: "Scale of the pattern (0.1 to 5.0)" },
                roughness: { type: "number", description: "Material roughness (0.0 to 1.0)" },
                metallic: { type: "number", description: "Material metallic (0.0 to 1.0)" },
                normalStrength: { type: "number", description: "Strength of the normal map (0.1 to 20.0)" },
                baseColor: { type: "array", items: { type: "number" } },
                secondaryColor: { type: "array", items: { type: "number" } }
            }
        }
    }, (args: any) => {
        Entropy.println("Updating PBR texture via tool: " + JSON.stringify(args));
        
        let compId = args.id || addonState.activeComponentId;
        let component = addonState.savedComponents.find(c => c.id === compId);
        
        if (!component) {
             if (!compId && addonState.currentParams) {
                 component = { id: "temp", name: "Temp", params: addonState.currentParams };
             } else {
                 return { success: false, error: "Texture component not found." };
             }
        }

        const params = component.params;
        
        if (typeof args.patternScale !== "undefined") params.patternScale = args.patternScale;
        if (typeof args.roughness !== "undefined") params.roughness = args.roughness;
        if (typeof args.metallic !== "undefined") params.metallic = args.metallic;
        if (typeof args.normalStrength !== "undefined") params.normalStrength = args.normalStrength;
        if (args.baseColor) params.baseColor = args.baseColor.length === 3 ? [...args.baseColor, 1.0] : args.baseColor;
        if (args.secondaryColor) params.secondaryColor = args.secondaryColor.length === 3 ? [...args.secondaryColor, 1.0] : args.secondaryColor;

        if (component.id === addonState.activeComponentId) {
            addonState.currentParams = params;
        }

        updatePreview(params, compId || "temp");
        
        persistState();

        return { success: true, params: { ...params } };
    });

    addon.registerTool({
        name: "list_pbr_textures",
        description: "List all created PBR texture components.",
        parameters: { type: "object", properties: {} }
    }, () => {
        const textures = addonState.savedComponents.map(c => ({
            id: c.id,
            name: c.name,
            patternType: c.params.patternType
        }));
        return { success: true, textures };
    });
});