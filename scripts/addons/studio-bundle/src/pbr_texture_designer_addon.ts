import { createNoise2D } from 'simplex-noise';
import Alea from 'alea';

const addon = Entropy.Addon.register({
    name: "PBR Texture Designer Pro",
    version: "2.0.0",
    description: "Procedural PBR Texture Generator with Multiple Pattern Types",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

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
    // Wood Grain
    woodRingFrequency: 0.3,
    woodGrainTurbulence: 2.0,
    woodGrainStretch: 3.0,
    
    // Marble
    marbleVeinFrequency: 0.02,
    marbleVeinContrast: 0.8,
    marbleTurbulence: 3.0,
    
    // Brick
    brickWidth: 64,
    brickHeight: 32,
    mortarWidth: 4,
    brickVariation: 0.15,
    
    // Hex Tiles
    hexSize: 40.0,
    hexGroutWidth: 3.0,
    hexVariation: 0.1,
    
    // Scales
    scaleSize: 30.0,
    scaleRoughness: 0.3,
    scaleOverlap: 0.15,
    
    // Fabric
    warpFrequency: 0.1,
    weftFrequency: 0.1,
    weaveIntensity: 0.5,
    
    // Rust
    rustCoverage: 0.4,
    rustSpotSize: 0.05,
    rustDepth: 0.6,
    
    previewRotation: [0.0, 0.0, 0.0],
    pipelineId: null as string | null
};

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
    const freq = texParams.heightFrequency * scale;
    const cNoise = (colorNoise2D(x * texParams.colorNoiseFreq * scale, y * texParams.colorNoiseFreq * scale) + 1) / 2;
    const v = (cNoise - 0.5) * texParams.colorVariation;
    
    return {
        color: [
            texParams.baseColor[0] + v,
            texParams.baseColor[1] + v,
            texParams.baseColor[2] + v,
            texParams.baseColor[3]
        ],
        height: 0.5
    };
}

function generateWoodGrain(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const centerX = 256;
    const centerY = 256;
    
    // Scale coordinates
    const sx = (x - centerX) / scale;
    const sy = (y - centerY) / scale / texParams.woodGrainStretch;
    
    // Distance from center (creates rings)
    const dist = Math.sqrt(sx * sx + sy * sy);
    const angle = Math.atan2(sy, sx);
    
    // Add turbulence to ring pattern
    const turbulence = noise2D(x * 0.01 * scale, y * 0.01 * scale) * texParams.woodGrainTurbulence;
    const ringPattern = Math.sin((dist + turbulence) * texParams.woodRingFrequency);
    
    // Add grain texture along the rings
    const grainNoise = noise2D(x * 0.02 * scale, y * 0.05 * scale);
    
    // Combine patterns
    const woodValue = (ringPattern + 1) / 2 * 0.7 + grainNoise * 0.3;
    
    // Interpolate between secondary (dark) and tertiary (light) based on pattern
    const color = lerpColor(texParams.secondaryColor, texParams.tertiaryColor, woodValue);
    
    return {
        color: color,
        height: woodValue
    };
}

function generateMarble(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    // Create flowing vein pattern with domain warping
    const warp1 = noise2D(x * texParams.marbleVeinFrequency * scale, y * texParams.marbleVeinFrequency * scale) * texParams.marbleTurbulence;
    const warp2 = noise2D((x + 100) * texParams.marbleVeinFrequency * scale, (y + 100) * texParams.marbleVeinFrequency * scale) * texParams.marbleTurbulence;
    
    // Create veins using warped coordinates
    const veinX = x + warp1 * 50;
    const veinY = y + warp2 * 50;
    const veinPattern = Math.sin(veinX * 0.05 * scale) * Math.cos(veinY * 0.05 * scale);
    
    // Add fine detail noise
    const detailNoise = noise2D(x * 0.1 * scale, y * 0.1 * scale) * 0.2;
    
    const marbleValue = (veinPattern + 1) / 2 * texParams.marbleVeinContrast + detailNoise;
    const normalizedValue = clamp01(marbleValue);
    
    // Base (white marble), Secondary (vein color), Tertiary (accent)
    let color;
    if (normalizedValue > 0.6) {
        color = lerpColor(texParams.baseColor, texParams.tertiaryColor, (normalizedValue - 0.6) * 2.5);
    } else {
        color = lerpColor(texParams.secondaryColor, texParams.baseColor, normalizedValue / 0.6);
    }
    
    return {
        color: color,
        height: normalizedValue * 0.3 + 0.35
    };
}

function generateBrick(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const brickW = texParams.brickWidth / scale;
    const brickH = texParams.brickHeight / scale;
    const mortarW = texParams.mortarWidth / scale;
    
    // Determine which row we're in
    const row = Math.floor(y / brickH);
    // Offset every other row for brick pattern
    const offsetX = (row % 2) * (brickW / 2);
    
    const localX = (x + offsetX) % brickW;
    const localY = y % brickH;
    
    // Check if we're in mortar area
    const isMortar = localX < mortarW || localY < mortarW;
    
    if (isMortar) {
        // Mortar uses secondary color
        return {
            color: texParams.secondaryColor,
            height: 0.2
        };
    } else {
        // Brick color with variation
        const brickId = Math.floor((x + offsetX) / brickW) + Math.floor(y / brickH) * 1000;
        const brickNoise = (noise2D(brickId * 0.1, brickId * 0.2) + 1) / 2;
        const variation = (brickNoise - 0.5) * texParams.brickVariation;
        
        const color = lerpColor(
            texParams.baseColor,
            texParams.tertiaryColor,
            0.5 + variation
        );
        
        // Add surface texture to brick
        const surfaceNoise = noise2D(x * 0.1 * scale, y * 0.1 * scale) * 0.1;
        
        return {
            color: color,
            height: 0.6 + surfaceNoise
        };
    }
}

function generateHexTiles(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const size = texParams.hexSize / scale;
    const grout = texParams.hexGroutWidth / scale;
    
    // Hexagonal tiling math
    const sqrt3 = Math.sqrt(3);
    const hexWidth = size * 2;
    const hexHeight = size * sqrt3;
    
    // Convert to hex grid coordinates
    const col = Math.floor(x / (hexWidth * 0.75));
    const row = Math.floor(y / hexHeight);
    
    // Offset every other column
    const yOffset = (col % 2) * (hexHeight / 2);
    
    const localX = x - col * (hexWidth * 0.75);
    const localY = y - row * hexHeight - yOffset;
    
    // Determine hex center
    const centerX = hexWidth / 2;
    const centerY = hexHeight / 2;
    
    const dx = localX - centerX;
    const dy = localY - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Check if in grout area (simplified as circular approximation)
    const isGrout = dist > (size - grout);
    
    if (isGrout) {
        return {
            color: texParams.secondaryColor,
            height: 0.15
        };
    } else {
        // Get tile ID for variation
        const tileId = col + row * 1000;
        const tileNoise = (noise2D(tileId * 0.1, tileId * 0.15) + 1) / 2;
        const variation = (tileNoise - 0.5) * texParams.hexVariation;
        
        const color = lerpColor(
            lerpColor(texParams.baseColor, texParams.tertiaryColor, 0.5),
            texParams.baseColor,
            variation
        );
        
        return {
            color: color,
            height: 0.5 + tileNoise * 0.1
        };
    }
}

function generateScales(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    const size = texParams.scaleSize / scale;
    const overlap = texParams.scaleOverlap;
    
    // Create overlapping scale pattern
    const row = Math.floor(y / (size * (1 - overlap)));
    const col = Math.floor(x / size);
    const offsetX = (row % 2) * (size / 2);
    
    const localX = (x - offsetX) % size;
    const localY = y % (size * (1 - overlap));
    
    // Create scale shape (elliptical)
    const centerX = size / 2;
    const centerY = size * (1 - overlap) / 2;
    
    const dx = (localX - centerX) / (size / 2);
    const dy = (localY - centerY) / (size * (1 - overlap) / 2);
    const distSq = dx * dx + dy * dy;
    
    // Get scale ID for color variation
    const scaleId = col + row * 1000;
    const scaleNoise = (noise2D(scaleId * 0.2, scaleId * 0.3) + 1) / 2;
    
    let height = 0.5;
    let color;
    
    if (distSq < 0.8) {
        // Inside scale
        const edgeDist = Math.sqrt(distSq);
        height = 0.7 - edgeDist * 0.3; // Raised in center, lower at edges
        
        // Color variation per scale
        const colorBlend = scaleNoise;
        color = lerpColor(texParams.baseColor, texParams.tertiaryColor, colorBlend);
        
        // Add texture detail
        const detailNoise = noise2D(x * 0.2 * scale, y * 0.2 * scale);
        color = color.map((c, i) => i < 3 ? clamp01(c + detailNoise * texParams.scaleRoughness * 0.2) : c);
    } else {
        // Between scales (skin showing)
        color = texParams.secondaryColor;
        height = 0.3;
    }
    
    return { color, height };
}

function generateFabric(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    // Weave pattern using sine waves
    const warpFreq = texParams.warpFrequency * scale;
    const weftFreq = texParams.weftFrequency * scale;
    
    const warp = Math.sin(x * warpFreq) * texParams.weaveIntensity;
    const weft = Math.sin(y * weftFreq) * texParams.weaveIntensity;
    
    // Create weave pattern
    const weavePattern = (warp + weft + 2) / 4;
    
    // Add fabric texture noise
    const fabricNoise = noise2D(x * 0.1 * scale, y * 0.1 * scale) * 0.2;
    
    const fabricValue = weavePattern + fabricNoise;
    
    // Interpolate between warp color (base), weft color (secondary), and highlight (tertiary)
    let color;
    if (fabricValue > 0.6) {
        color = lerpColor(texParams.baseColor, texParams.tertiaryColor, (fabricValue - 0.6) * 2.5);
    } else {
        color = lerpColor(texParams.secondaryColor, texParams.baseColor, fabricValue / 0.6);
    }
    
    return {
        color: color,
        height: 0.4 + weavePattern * 0.2
    };
}

function generateRust(x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) {
    // Base metal
    const metalNoise = (noise2D(x * 0.05 * scale, y * 0.05 * scale) + 1) / 2;
    
    // Rust spots using multiple noise octaves
    const rustNoise1 = (noise2D(x * texParams.rustSpotSize * scale, y * texParams.rustSpotSize * scale) + 1) / 2;
    const rustNoise2 = (noise2D(x * texParams.rustSpotSize * 2 * scale, y * texParams.rustSpotSize * 2 * scale) + 1) / 2;
    
    const rustAmount = (rustNoise1 * 0.7 + rustNoise2 * 0.3);
    
    // Determine if this pixel is rusted
    const isRusted = rustAmount < texParams.rustCoverage;
    
    let color;
    let height;
    
    if (isRusted) {
        // Rust colors - blend between base (rust brown), secondary (dark rust), tertiary (orange rust)
        const rustIntensity = rustAmount / texParams.rustCoverage;
        if (rustIntensity < 0.3) {
            color = lerpColor(texParams.secondaryColor, texParams.baseColor, rustIntensity / 0.3);
        } else {
            color = lerpColor(texParams.baseColor, texParams.tertiaryColor, (rustIntensity - 0.3) / 0.7);
        }
        height = 0.3 + rustAmount * 0.3; // Rust is pitted
    } else {
        // Clean metal (using tertiary as clean metal color)
        color = lerpColor(texParams.tertiaryColor, texParams.baseColor, metalNoise * 0.3);
        height = 0.6 + metalNoise * 0.2;
    }
    
    return { color, height };
}

// ============= TEXTURE GENERATION =============

function generateTextures(resolution: number) {
    const res = resolution;
    const prng = Alea(texParams.seed);
    const noise2D = createNoise2D(prng);
    const colorPrng = Alea(texParams.seed + 1);
    const colorNoise2D = createNoise2D(colorPrng);

    const diffData = new Uint8Array(res * res * 4);
    const norData = new Uint8Array(res * res * 4);
    const armData = new Uint8Array(res * res * 4);

    const scale = texParams.patternScale;

    // Select pattern generator
    let patternGenerator: (x: number, y: number, noise2D: any, colorNoise2D: any, scale: number) => {color: number[], height: number};
    
    switch (texParams.patternType) {
        case 'wood_grain':
            patternGenerator = generateWoodGrain;
            break;
        case 'marble':
            patternGenerator = generateMarble;
            break;
        case 'brick':
            patternGenerator = generateBrick;
            break;
        case 'hex_tiles':
            patternGenerator = generateHexTiles;
            break;
        case 'scales':
            patternGenerator = generateScales;
            break;
        case 'fabric':
            patternGenerator = generateFabric;
            break;
        case 'rust':
            patternGenerator = generateRust;
            break;
        default:
            patternGenerator = generateNoisePattern;
    }

    // First pass: generate height map
    const heightMap: number[][] = [];
    for (let y = 0; y < res; y++) {
        heightMap[y] = [];
        for (let x = 0; x < res; x++) {
            const result = patternGenerator(x, y, noise2D, colorNoise2D, scale);
            heightMap[y][x] = result.height;
        }
    }

    // Second pass: generate all textures
    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            const idx = (y * res + x) * 4;
            
            const result = patternGenerator(x, y, noise2D, colorNoise2D, scale);
            const h = result.height;

            // Diffuse (Albedo)
            diffData[idx] = Math.max(0, Math.min(255, result.color[0] * 255));
            diffData[idx + 1] = Math.max(0, Math.min(255, result.color[1] * 255));
            diffData[idx + 2] = Math.max(0, Math.min(255, result.color[2] * 255));
            diffData[idx + 3] = 255;

            // ARM (Ambient Occlusion, Roughness, Metallic)
            const ao = Math.max(0, Math.min(255, (h * 0.5 + 0.5) * texParams.aoStrength * 255));
            armData[idx] = ao;
            armData[idx + 1] = texParams.roughness * 255;
            armData[idx + 2] = texParams.metallic * 255;
            armData[idx + 3] = 255;

            // Normal map from height map
            const hL = heightMap[y][Math.max(0, x - 1)];
            const hR = heightMap[y][Math.min(res - 1, x + 1)];
            const hU = heightMap[Math.max(0, y - 1)][x];
            const hD = heightMap[Math.min(res - 1, y + 1)][x];
            
            const nx = (hL - hR) * texParams.normalStrength;
            const ny = (hU - hD) * texParams.normalStrength;
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

function updatePreview() {
    if (!texParams.pipelineId) return;

    const res = texParams.previewRes;
    Entropy.println(`Generating ${texParams.patternType} preview at ${res}x${res}...`);

    const { diffData, norData, armData } = generateTextures(res);

    const diffId = addon.Texture.create(res, res, diffData);
    const norId = addon.Texture.create(res, res, norData);
    const armId = addon.Texture.create(res, res, armData);

    // Expose for interop
    globalThis.lastPBRDesignerTextures = {
        diffId,
        norId,
        armId,
        params: { ...texParams }
    };

    if (typeof globalThis.onPBRDesignerUpdate === 'function') {
        globalThis.onPBRDesignerUpdate();
    }

    const { vertices, indices } = generateCubeData();
    
    addon.Model.clearMeshes();
    addon.Model.createMesh({
        pipelineId: texParams.pipelineId,
        position: [-2, 0, -2],
        rotation: texParams.previewRotation,
        scale: [2, 2, 2],
        vertexData: vertices,
        indexData: indices,
        renderRole: "General",
        bindings: [
            {
                group: 2,
                binding: 0,
                resource: {
                    type: "Uniform",
                    value: {
                        data: [
                            texParams.seed, 0, 0, 0,
                            ...texParams.baseColor,
                            texParams.roughness, texParams.metallic, texParams.aoStrength, texParams.normalStrength,
                        ]
                    }
                }
            },
            { group: 2, binding: 1, resource: { type: "Texture", value: {id: diffId} } },
            { group: 2, binding: 2, resource: { type: "Sampler" } },
            { group: 2, binding: 3, resource: { type: "Texture", value: {id: norId} } },
            { group: 2, binding: 4, resource: { type: "Texture", value: {id: armId} } }
        ]
    });
    
    Entropy.println(`✓ ${texParams.patternType} preview updated!`);
}

function saveTextures() {
    const res = texParams.resolution;
    Entropy.println(`Generating ${texParams.patternType} textures at ${res}x${res}...`);

    const { diffData, norData, armData } = generateTextures(res);

    const prefix = `${texParams.patternType}_${texParams.seed}`;
    addon.IO.saveImage(`${prefix}_diff.png`, res, res, diffData);
    addon.IO.saveImage(`${prefix}_nor_gl.png`, res, res, norData);
    addon.IO.saveImage(`${prefix}_arm.png`, res, res, armData);
    Entropy.println(`✓ Saved textures as ${prefix}_*.png`);
}

addon.onInit(async () => {
    Entropy.println("🎨 PBR Texture Designer Pro Initializing...");

    const pipelineId = Entropy.Pipeline.create({
        name: "PBR_Preview_Pipeline",
        pbr: true,
        layout: "mesh",
        vertexShader: PREVIEW_SHADER,
        fragmentShader: PREVIEW_SHADER,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
                    { binding: 1, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 2, visibility: ["Fragment"], resourceType: "Sampler" },
                    { binding: 3, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 4, visibility: ["Fragment"], resourceType: "Texture" }
                ]
            }
        ]
    });

    texParams.pipelineId = pipelineId;

    const savedData = addon.IO.load();
    if (savedData) {
        texParams = { ...texParams, ...savedData };
    }

    Entropy.println("🎨 PBR Texture Designer Pro Initializing..." + pipelineId + " " + texParams.pipelineId);

    // Atmospheric lighting
    addon.Lighting.createPointLight({
        position: [-3.0, 4.0, 5.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 50.0
    });

    addon.Lighting.createPointLight({
        position: [3.0, 4.0, 10.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 50.0
    });

    addon.Lighting.createPointLight({
        position: [0.0, 5.0, -10.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 50.0
    });

    updatePreview();

    const renderUI = (tab: string) => {
        Entropy.UI.Widget.label(tab, { text: "🎨 PBR Texture Designer Pro", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "🚀 GENERATE & SAVE PNGs",
            onClick: () => saveTextures()
        });

        Entropy.UI.Widget.label(tab, { text: "📐 Pattern Selection", bold: true });

        let patternOptions = ["noise", "wood_grain", "marble", "brick", "hex_tiles", "scales", "fabric", "rust"] as PatternType[];
        
        Entropy.UI.Widget.dropdown(tab, {
            label: "Pattern Type",
            options: patternOptions,
            selectedIndex: patternOptions.indexOf(texParams.patternType),
            onChange: (val) => { 
                texParams.patternType = patternOptions[parseInt(val)]; 
                updatePreview(); 
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Pattern Scale",
            value: texParams.patternScale,
            min: 0.1, max: 5.0,
            onChange: (v) => { texParams.patternScale = parseFloat(v); updatePreview(); }
        });

        Entropy.UI.Widget.label(tab, { text: "🎨 Colors", bold: true });
        
        Entropy.UI.Widget.colorInput(tab, {
            label: "Base Color",
            color: texParams.baseColor,
            onChange: (c) => { texParams.baseColor = c; updatePreview(); }
        });

        Entropy.UI.Widget.colorInput(tab, {
            label: "Secondary Color",
            color: texParams.secondaryColor,
            onChange: (c) => { texParams.secondaryColor = c; updatePreview(); }
        });

        Entropy.UI.Widget.colorInput(tab, {
            label: "Tertiary Color",
            color: texParams.tertiaryColor,
            onChange: (c) => { texParams.tertiaryColor = c; updatePreview(); }
        });

        Entropy.UI.Widget.label(tab, { text: "🔧 Core Settings", bold: true });
        
        Entropy.UI.Widget.numericInput(tab, {
            label: "Seed",
            value: texParams.seed,
            onChange: (val) => { texParams.seed = parseInt(val); updatePreview(); }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Normal Strength",
            value: texParams.normalStrength,
            min: 0.1, max: 20.0,
            onChange: (v) => { texParams.normalStrength = parseFloat(v); updatePreview(); }
        });

        Entropy.UI.Widget.label(tab, { text: "💎 Material (PBR)", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Roughness",
            value: texParams.roughness,
            min: 0, max: 1,
            onChange: (v) => { texParams.roughness = parseFloat(v); updatePreview(); }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Metallic",
            value: texParams.metallic,
            min: 0, max: 1,
            onChange: (v) => { texParams.metallic = parseFloat(v); updatePreview(); }
        });

        // Pattern-specific controls
        if (texParams.patternType === 'wood_grain') {
            Entropy.UI.Widget.label(tab, { text: "🌲 Wood Grain Settings", bold: true });
            Entropy.UI.Widget.slider(tab, {
                label: "Ring Frequency",
                value: texParams.woodRingFrequency,
                min: 0.1, max: 1.0,
                onChange: (v) => { texParams.woodRingFrequency = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Grain Turbulence",
                value: texParams.woodGrainTurbulence,
                min: 0.5, max: 5.0,
                onChange: (v) => { texParams.woodGrainTurbulence = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Grain Stretch",
                value: texParams.woodGrainStretch,
                min: 1.0, max: 5.0,
                onChange: (v) => { texParams.woodGrainStretch = parseFloat(v); updatePreview(); }
            });
        }

        if (texParams.patternType === 'marble') {
            Entropy.UI.Widget.label(tab, { text: "⚪ Marble Settings", bold: true });
            Entropy.UI.Widget.slider(tab, {
                label: "Vein Frequency",
                value: texParams.marbleVeinFrequency,
                min: 0.01, max: 0.1,
                onChange: (v) => { texParams.marbleVeinFrequency = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Vein Contrast",
                value: texParams.marbleVeinContrast,
                min: 0.1, max: 2.0,
                onChange: (v) => { texParams.marbleVeinContrast = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Turbulence",
                value: texParams.marbleTurbulence,
                min: 0.5, max: 10.0,
                onChange: (v) => { texParams.marbleTurbulence = parseFloat(v); updatePreview(); }
            });
        }

        if (texParams.patternType === 'brick') {
            Entropy.UI.Widget.label(tab, { text: "🧱 Brick Settings", bold: true });
            Entropy.UI.Widget.slider(tab, {
                label: "Brick Width",
                value: texParams.brickWidth,
                min: 20, max: 128,
                onChange: (v) => { texParams.brickWidth = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Brick Height",
                value: texParams.brickHeight,
                min: 10, max: 64,
                onChange: (v) => { texParams.brickHeight = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Mortar Width",
                value: texParams.mortarWidth,
                min: 1, max: 10,
                onChange: (v) => { texParams.mortarWidth = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Brick Variation",
                value: texParams.brickVariation,
                min: 0.0, max: 0.5,
                onChange: (v) => { texParams.brickVariation = parseFloat(v); updatePreview(); }
            });
        }

        if (texParams.patternType === 'hex_tiles') {
            Entropy.UI.Widget.label(tab, { text: "⬡ Hex Tile Settings", bold: true });
            Entropy.UI.Widget.slider(tab, {
                label: "Hex Size",
                value: texParams.hexSize,
                min: 10, max: 100,
                onChange: (v) => { texParams.hexSize = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Grout Width",
                value: texParams.hexGroutWidth,
                min: 1, max: 10,
                onChange: (v) => { texParams.hexGroutWidth = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Tile Variation",
                value: texParams.hexVariation,
                min: 0.0, max: 0.5,
                onChange: (v) => { texParams.hexVariation = parseFloat(v); updatePreview(); }
            });
        }

        if (texParams.patternType === 'scales') {
            Entropy.UI.Widget.label(tab, { text: "🐉 Scale Settings", bold: true });
            Entropy.UI.Widget.slider(tab, {
                label: "Scale Size",
                value: texParams.scaleSize,
                min: 10, max: 100,
                onChange: (v) => { texParams.scaleSize = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Scale Overlap",
                value: texParams.scaleOverlap,
                min: 0.0, max: 0.5,
                onChange: (v) => { texParams.scaleOverlap = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Scale Roughness",
                value: texParams.scaleRoughness,
                min: 0.0, max: 1.0,
                onChange: (v) => { texParams.scaleRoughness = parseFloat(v); updatePreview(); }
            });
        }

        if (texParams.patternType === 'fabric') {
            Entropy.UI.Widget.label(tab, { text: "🧵 Fabric Settings", bold: true });
            Entropy.UI.Widget.slider(tab, {
                label: "Warp Frequency",
                value: texParams.warpFrequency,
                min: 0.01, max: 0.5,
                onChange: (v) => { texParams.warpFrequency = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Weft Frequency",
                value: texParams.weftFrequency,
                min: 0.01, max: 0.5,
                onChange: (v) => { texParams.weftFrequency = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Weave Intensity",
                value: texParams.weaveIntensity,
                min: 0.1, max: 2.0,
                onChange: (v) => { texParams.weaveIntensity = parseFloat(v); updatePreview(); }
            });
        }

        if (texParams.patternType === 'rust') {
            Entropy.UI.Widget.label(tab, { text: "🦀 Rust Settings", bold: true });
            Entropy.UI.Widget.slider(tab, {
                label: "Rust Coverage",
                value: texParams.rustCoverage,
                min: 0.0, max: 1.0,
                onChange: (v) => { texParams.rustCoverage = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Rust Spot Size",
                value: texParams.rustSpotSize,
                min: 0.01, max: 0.2,
                onChange: (v) => { texParams.rustSpotSize = parseFloat(v); updatePreview(); }
            });
            Entropy.UI.Widget.slider(tab, {
                label: "Rust Depth",
                value: texParams.rustDepth,
                min: 0.0, max: 1.0,
                onChange: (v) => { texParams.rustDepth = parseFloat(v); updatePreview(); }
            });
        }

        Entropy.UI.Widget.label(tab, { text: "🔄 Preview Rotation", bold: true });
        Entropy.UI.Widget.slider(tab, {
            label: "Rotation Y",
            value: texParams.previewRotation[1],
            min: 0, max: 6.28,
            onChange: (v) => { texParams.previewRotation[1] = parseFloat(v); updatePreview(); }
        });
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("PBR Texture Designer Pro", renderUI);
    }

    const tab = addon.UI.createTab({
        title: "Texture Designer Pro",
        onRender: async () => renderUI(tab)
    });

    Entropy.println("✓ PBR Texture Designer Pro Initialized!");
});