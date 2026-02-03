import { createNoise2D } from 'simplex-noise';
import Alea from 'alea';

const addon = Entropy.Addon.register({
    name: "PBR Texture Designer",
    version: "1.1.0",
    description: "Procedural PBR Texture Generator with Real-time Preview",
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
    let arm = textureSample(t_arm, s_diffuse, in.uv);
    
    var out: GbufferOutput;
    out.position = vec4<f32>(in.world_pos, 1.0);
    out.normal = vec4<f32>(normalize(in.normal + normal_map * 0.5), 1.0);
    out.albedo = albedo;
    out.pbr_material = arm;
    return out;
}
`;

let texParams = {
    seed: 1234,
    resolution: 512,
    previewRes: 128,
    baseColor: [0.5, 0.4, 0.3, 1.0],
    roughness: 0.8,
    metallic: 0.0,
    aoStrength: 1.0,
    heightFrequency: 0.02,
    heightOctaves: 4,
    heightPersistence: 0.5,
    heightLacunarity: 2.0,
    normalStrength: 10.0,
    colorVariation: 0.1,
    colorNoiseFreq: 0.05,
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

function updatePreview() {
    if (!texParams.pipelineId) return;

    const res = texParams.previewRes;
    const prng = Alea(texParams.seed);
    const noise2D = createNoise2D(prng);
    const colorPrng = Alea(texParams.seed + 1);
    const colorNoise2D = createNoise2D(colorPrng);

    const diffData = new Uint8Array(res * res * 4);
    const norData = new Uint8Array(res * res * 4);
    const armData = new Uint8Array(res * res * 4);

    const getHeight = (x: number, y: number) => {
        let val = 0;
        let amp = 1;
        let freq = texParams.heightFrequency * (512 / res);
        let maxV = 0;
        for (let i = 0; i < texParams.heightOctaves; i++) {
            val += (noise2D(x * freq, y * freq) + 1) / 2 * amp;
            maxV += amp;
            amp *= texParams.heightPersistence;
            freq *= texParams.heightLacunarity;
        }
        return val / maxV;
    };

    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            const idx = (y * res + x) * 4;
            const h = getHeight(x, y);

            const cNoise = (colorNoise2D(x * texParams.colorNoiseFreq * (512 / res), y * texParams.colorNoiseFreq * (512 / res)) + 1) / 2;
            const v = (cNoise - 0.5) * texParams.colorVariation;
            diffData[idx] = Math.max(0, Math.min(255, (texParams.baseColor[0] + v) * 255));
            diffData[idx + 1] = Math.max(0, Math.min(255, (texParams.baseColor[1] + v) * 255));
            diffData[idx + 2] = Math.max(0, Math.min(255, (texParams.baseColor[2] + v) * 255));
            diffData[idx + 3] = 255;

            const ao = Math.max(0, Math.min(255, (h * 0.5 + 0.5) * texParams.aoStrength * 255));
            armData[idx] = texParams.metallic * 255; 
            armData[idx + 1] = texParams.roughness * 255; 
            armData[idx + 2] = ao; 
            armData[idx + 3] = 255;

            const hL = getHeight(x - 1, y);
            const hR = getHeight(x + 1, y);
            const hU = getHeight(x, y - 1);
            const hD = getHeight(x, y + 1);
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

    Entropy.println("PBR Texture Designer with Preview Creating Textures...");

    const diffId = addon.Texture.create(res, res, diffData);
    const norId = addon.Texture.create(res, res, norData);
    const armId = addon.Texture.create(res, res, armData);

    Entropy.println("PBR Texture Designer with Preview Textures Created...");

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

    const getHeight = (x: number, y: number) => {
        let val = 0;
        let amp = 1;
        let freq = texParams.heightFrequency;
        let maxV = 0;
        for (let i = 0; i < texParams.heightOctaves; i++) {
            val += (noise2D(x * freq, y * freq) + 1) / 2 * amp;
            maxV += amp;
            amp *= texParams.heightPersistence;
            freq *= texParams.heightLacunarity;
        }
        return val / maxV;
    };

    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            const idx = (y * res + x) * 4;
            const h = getHeight(x, y);
            const hv = Math.floor(h * 255);
            dispData[idx] = hv; dispData[idx + 1] = hv; dispData[idx + 2] = hv; dispData[idx + 3] = 255;

            const cNoise = (colorNoise2D(x * texParams.colorNoiseFreq, y * texParams.colorNoiseFreq) + 1) / 2;
            const v = (cNoise - 0.5) * texParams.colorVariation;
            diffData[idx] = Math.max(0, Math.min(255, (texParams.baseColor[0] + v) * 255));
            diffData[idx + 1] = Math.max(0, Math.min(255, (texParams.baseColor[1] + v) * 255));
            diffData[idx + 2] = Math.max(0, Math.min(255, (texParams.baseColor[2] + v) * 255));
            diffData[idx + 3] = 255;

            const ao = Math.max(0, Math.min(255, (h * 0.5 + 0.5) * texParams.aoStrength * 255));
            armData[idx] = ao; 
            armData[idx + 1] = texParams.roughness * 255; 
            armData[idx + 2] = texParams.metallic * 255; 
            armData[idx + 3] = 255;

            const hL = getHeight(x - 1, y);
            const hR = getHeight(x + 1, y);
            const hU = getHeight(x, y - 1);
            const hD = getHeight(x, y + 1);
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

    const prefix = `proc_${texParams.seed}`;
    addon.IO.saveImage(`${prefix}_diff.png`, res, res, diffData);
    addon.IO.saveImage(`${prefix}_disp.png`, res, res, dispData);
    addon.IO.saveImage(`${prefix}_nor_gl.png`, res, res, norData);
    addon.IO.saveImage(`${prefix}_arm.png`, res, res, armData);
    Entropy.println(`Saved textures as ${prefix}_*.png`);
}

addon.onInit(async () => {
    Entropy.println("PBR Texture Designer with Preview Initializing...");

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

    Entropy.println("PBR Texture Designer with Preview Pipeline Created...");

    texParams.pipelineId = pipelineId;

    const savedData = addon.IO.load();
    if (savedData) {
        texParams = { ...texParams, ...savedData };
    }

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

    Entropy.println("Created PBR Texture Preview lights, about to create preview...");

    updatePreview();

    Entropy.println("PBR Texture Designer with Preview continuing...");

    const renderUI = (tab: string) => {
        Entropy.UI.Widget.label(tab, { text: "🎨 PBR Texture Designer", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "🚀 GENERATE & SAVE PNGs",
            onClick: () => saveTextures()
        });

        Entropy.UI.Widget.label(tab, { text: "📐 Core Settings", bold: true });
        Entropy.UI.Widget.numericInput(tab, {
            label: "Seed",
            value: texParams.seed,
            onChange: (val) => { texParams.seed = parseInt(val); updatePreview(); }
        });

        Entropy.UI.Widget.label(tab, { text: "🎨 Albedo (Diffuse)", bold: true });
        Entropy.UI.Widget.colorInput(tab, {
            label: "Base Color",
            color: texParams.baseColor,
            onChange: (c) => { texParams.baseColor = c; updatePreview(); }
        });

        Entropy.UI.Widget.label(tab, { text: "⛰️ Height & Normals", bold: true });
        Entropy.UI.Widget.slider(tab, {
            label: "Height Frequency",
            value: texParams.heightFrequency,
            min: 0.001, max: 0.1,
            onChange: (v) => { texParams.heightFrequency = parseFloat(v); updatePreview(); }
        });
        Entropy.UI.Widget.slider(tab, {
            label: "Normal Strength",
            value: texParams.normalStrength,
            min: 0.1, max: 20.0,
            onChange: (v) => { texParams.normalStrength = parseFloat(v); updatePreview(); }
        });

        Entropy.UI.Widget.label(tab, { text: "💎 Material (ARM)", bold: true });
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

        Entropy.UI.Widget.label(tab, { text: "🔄 Preview Rotation", bold: true });
        Entropy.UI.Widget.slider(tab, {
            label: "Rotation Y",
            value: texParams.previewRotation[1],
            min: 0, max: 6.28,
            onChange: (v) => { texParams.previewRotation[1] = parseFloat(v); updatePreview(); }
        });
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("PBR Texture Designer", renderUI);
    }

    const tab = addon.UI.createTab({
        title: "Texture Designer",
        onRender: async () => renderUI(tab)
    });

    Entropy.println("PBR Texture Designer with Preview Inititialzed!");
});