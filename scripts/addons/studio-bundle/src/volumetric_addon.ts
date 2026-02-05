// Volumetric Addon
// Implements volumetric fog and clouds via custom deferred lighting pass

interface VolumetricParams {
    density: number;
    absorption: number;
    scattering: number;
    noiseScale: number;
    noiseSpeed: number;
    color: [number, number, number, number];
    steps: number;
}

const addonInfo = {
    name: "Volumetric",
    version: "1.1.0",
    description: "Advanced volumetric effects including clouds and fog (Optimized)",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

const volumetricLightingShader = `
struct DirectionalLight {
    direction: vec3<f32>,
    _padding0: u32,
    color: vec3<f32>,
    _padding1: u32,
};

const MAX_POINT_LIGHTS: u32 = 10;
struct PointLight {
    position: vec3<f32>,
    _padding0: f32,
    color: vec3<f32>,
    _padding1: f32,
    intensity: f32,
    max_distance: f32,
    _padding: vec2<f32>,
};

struct PointLights {
    point_lights: array<PointLight, MAX_POINT_LIGHTS>,
    num_point_lights: u32,
};

struct WindowSize {
    width: f32,
    height: f32,
};

struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
    window_size: WindowSize,
};

struct VolumetricUniform {
    color: vec4<f32>,
    density: f32,
    absorption: f32,
    scattering: f32,
    noise_scale: f32,
    noise_speed: f32,
    time: f32,
    steps: f32,
    _padding: f32,
};

@group(0) @binding(0) var<uniform> directional_light: DirectionalLight;
@group(0) @binding(1) var<uniform> point_lights: PointLights;

@group(1) @binding(0) var g_buffer_position: texture_2d<f32>;
@group(1) @binding(1) var g_buffer_normal: texture_2d<f32>;
@group(1) @binding(2) var g_buffer_albedo: texture_2d<f32>;
@group(1) @binding(3) var g_buffer_pbr_material: texture_2d<f32>;
@group(1) @binding(4) var s_g_buffer: sampler;

@group(2) @binding(0) var<uniform> camera: Camera;

@group(3) @binding(0) var<uniform> light_view_proj: mat4x4<f32>;
@group(3) @binding(1) var shadow_map: texture_depth_2d;
@group(3) @binding(2) var shadow_sampler: sampler_comparison;

@group(4) @binding(0) var<uniform> vol: VolumetricUniform;

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> @builtin(position) vec4<f32> {
    var out_pos: vec2<f32>;
    if (in_vertex_index == 0u) {
        out_pos = vec2<f32>(-1.0, 3.0);
    } else if (in_vertex_index == 1u) {
        out_pos = vec2<f32>(-1.0, -1.0);
    } else {
        out_pos = vec2<f32>(3.0, -1.0);
    }
    return vec4<f32>(out_pos, 0.0, 1.0);
}

// Simple hash for noise
fn hash3(p_in: vec3<f32>) -> f32 {
    var p = fract(p_in * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

fn noise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);

    return mix(mix(mix(hash3(i + vec3<f32>(0.0, 0.0, 0.0)), 
                       hash3(i + vec3<f32>(1.0, 0.0, 0.0)), u.x),
                   mix(hash3(i + vec3<f32>(0.0, 1.0, 0.0)), 
                       hash3(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
               mix(mix(hash3(i + vec3<f32>(0.0, 0.0, 1.0)), 
                       hash3(i + vec3<f32>(1.0, 0.0, 1.0)), u.x),
                   mix(hash3(i + vec3<f32>(0.0, 1.0, 1.0)), 
                       hash3(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

fn fbm(p_in: vec3<f32>) -> f32 {
    var v = 0.0;
    var a = 0.5;
    let shift = vec3<f32>(100.0);
    var p = p_in;
    for (var i = 0; i < 3; i = i + 1) {
        v += a * noise3(p);
        p = p * 2.0 + shift;
        a *= 0.5;
    }
    return v;
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let tex_coords = frag_coord.xy / vec2<f32>(camera.window_size.width, camera.window_size.height);

    let position_data = textureSample(g_buffer_position, s_g_buffer, tex_coords);
    let position = position_data.xyz;
    let is_background = position_data.w < 0.0001;
    
    let normal_data = textureSample(g_buffer_normal, s_g_buffer, tex_coords);
    let normal = normalize(normal_data.xyz);
    let albedo = textureSample(g_buffer_albedo, s_g_buffer, tex_coords).rgb;
    let pbr_material = textureSample(g_buffer_pbr_material, s_g_buffer, tex_coords).rgb;

    let view_dir = normalize(camera.view_pos.xyz - position);
    
    // Simple Lighting
    var total_lighting = vec3<f32>(0.0);
    if (!is_background) {
        let ambient = vec3<f32>(0.05) * albedo;
        let light_dir = normalize(directional_light.direction);
        let diff = max(dot(normal, light_dir), 0.0);
        total_lighting = ambient + diff * albedo * directional_light.color;
        
        for (var i: u32 = 0; i < point_lights.num_point_lights; i = i + 1) {
            let p_light = point_lights.point_lights[i];
            let light_vec = p_light.position - position;
            let distance = length(light_vec);
            if (distance < p_light.max_distance) {
                let p_light_dir = normalize(light_vec);
                let attenuation = 1.0 - pow(distance / p_light.max_distance, 2.0);
                total_lighting += max(dot(normal, p_light_dir), 0.0) * albedo * p_light.color * p_light.intensity * attenuation;
            }
        }
    } else {
        total_lighting = vec3<f32>(0.0);
    }

    // --- Volumetric Raymarching ---
    let ray_origin = camera.view_pos.xyz;
    var ray_end = position;
    if (is_background) {
        ray_end = ray_origin + normalize(position - ray_origin) * 500.0;
    }
    
    let ray_vec = ray_end - ray_origin;
    let ray_dist = length(ray_vec);
    let ray_dir = ray_vec / ray_dist;
    
    let max_dist = 300.0;
    let actual_dist = min(ray_dist, max_dist);
    
    let steps = i32(vol.steps);
    let step_size = actual_dist / f32(max(steps, 1));
    var transmittance = 1.0;
    var scattered_light = vec3<f32>(0.0);
    
    let noise_offset = vec3<f32>(vol.time * vol.noise_speed, 0.0, 0.0);
    
    for (var i = 0; i < steps; i = i + 1) {
        let p = ray_origin + ray_dir * (f32(i) + 0.5) * step_size;
        
        // Vertical density gradient
        let height_factor = exp(-max(p.y - 0.0, 0.0) * 0.1);
        let density_sample = fbm(p * vol.noise_scale + noise_offset) * vol.density * height_factor;
        
        if (density_sample > 0.001) {
            let extinction = (vol.absorption + vol.scattering) * density_sample;
            let step_transmittance = exp(-extinction * step_size);
            
            let light_dir = normalize(directional_light.direction);
            let phase = 1.0; 
            let luminance = directional_light.color * vol.scattering * density_sample * phase;
            
            let integrated_light = (luminance - luminance * step_transmittance) / max(extinction, 0.0001);
            scattered_light += integrated_light * transmittance;
            
            transmittance *= step_transmittance;
        }
        
        if (transmittance < 0.01) {
            break;
        }
    }
    
    let final_color = total_lighting * transmittance + scattered_light * vol.color.rgb;

    return vec4<f32>(final_color, 1.0);
}
`;

let currentParams: VolumetricParams = {
    density: 0.02,
    absorption: 0.1,
    scattering: 0.5,
    noiseScale: 0.05,
    noiseSpeed: 0.1,
    color: [0.8, 0.9, 1.0, 1.0],
    steps: 16
};

const presets: Record<string, VolumetricParams> = {
    "Clear": {
        density: 0.0,
        absorption: 0.1,
        scattering: 0.5,
        noiseScale: 0.05,
        noiseSpeed: 0.1,
        color: [0.8, 0.9, 1.0, 1.0],
        steps: 16
    },
    "Light Mist": {
        density: 0.02,
        absorption: 0.05,
        scattering: 0.2,
        noiseScale: 0.1,
        noiseSpeed: 0.05,
        color: [0.9, 0.95, 1.0, 1.0],
        steps: 16
    },
    "Heavy Fog": {
        density: 0.1,
        absorption: 0.2,
        scattering: 0.8,
        noiseScale: 0.02,
        noiseSpeed: 0.02,
        color: [0.7, 0.7, 0.75, 1.0],
        steps: 24
    },
    "Volumetric Clouds": {
        density: 0.5,
        absorption: 0.5,
        scattering: 2.0,
        noiseScale: 0.01,
        noiseSpeed: 0.2,
        color: [1.0, 1.0, 1.0, 1.0],
        steps: 32
    },
    "Alien Swamp": {
        density: 0.08,
        absorption: 0.3,
        scattering: 1.5,
        noiseScale: 0.08,
        noiseSpeed: 0.3,
        color: [0.4, 1.0, 0.4, 1.0],
        steps: 24
    },
    "Inferno": {
        density: 0.15,
        absorption: 1.0,
        scattering: 2.5,
        noiseScale: 0.15,
        noiseSpeed: 1.0,
        color: [1.0, 0.3, 0.0, 1.0],
        steps: 24
    }
};

let pipelineId: string | null = null;
let uniformBufferId: string | null = null;
let startTime = Date.now();

addon.onInit(async () => {
    Entropy.println("Volumetric Addon starting...");

    // Create uniform buffer for volumetric parameters
    // VolumetricUniform size: 4*4 (color) + 4*7 (floats) + 4 (padding) = 16 + 28 + 4 = 48 bytes
    uniformBufferId = addon.Buffer.create({
        size: 48,
        usage: "Uniform"
    });

    // Create pipeline using the buffer ID
    pipelineId = Entropy.Pipeline.create({
        name: "volumetric_lighting",
        pbr: true,
        lightingShader: volumetricLightingShader,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Fragment", "Vertex"], resourceType: "Uniform" }
                ]
            }
        ],
        lightingBindings: [
            {
                group: 4,
                binding: 0,
                resource: {
                    type: "Buffer",
                    value: { id: uniformBufferId }
                }
            }
        ]
    });

    // Initial buffer write
    updateUniformBuffer();

    // Dummy cube to activate pipeline
    addon.Model.createProcedural({
        type: "cube",
        pipelineId: pipelineId,
        parameters: {
            position: [0.0, -1000.0, 0.0],
            scale: [0.1, 0.1, 0.1]
        }
    });

    const renderUI = (tab: string) => {
        Entropy.UI.Widget.label(tab, { text: "Volumetric Presets", bold: true });
        
        Entropy.UI.Widget.dropdown(tab, {
            label: "Select Preset",
            options: Object.keys(presets),
            selectedIndex: Object.keys(presets).indexOf("Light Mist"),
            onChange: (idx: string) => {
                const presetName = Object.keys(presets)[parseInt(idx)];
                currentParams = { ...presets[presetName] };
                updateUniformBuffer();
            }
        });

        Entropy.UI.Widget.label(tab, { text: "Manual Controls", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Density",
            value: currentParams.density,
            min: 0,
            max: 1.0,
            onChange: (val: any) => {
                currentParams.density = parseFloat(val);
                updateUniformBuffer();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Scattering",
            value: currentParams.scattering,
            min: 0,
            max: 5.0,
            onChange: (val: any) => {
                currentParams.scattering = parseFloat(val);
                updateUniformBuffer();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Absorption",
            value: currentParams.absorption,
            min: 0,
            max: 2.0,
            onChange: (val: any) => {
                currentParams.absorption = parseFloat(val);
                updateUniformBuffer();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Noise Scale",
            value: currentParams.noiseScale,
            min: 0.001,
            max: 0.5,
            onChange: (val: any) => {
                currentParams.noiseScale = parseFloat(val);
                updateUniformBuffer();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Noise Speed",
            value: currentParams.noiseSpeed,
            min: 0,
            max: 2.0,
            onChange: (val: any) => {
                currentParams.noiseSpeed = parseFloat(val);
                updateUniformBuffer();
            }
        });

        Entropy.UI.Widget.colorInput(tab, {
            label: "Volume Color",
            color: currentParams.color.slice(0, 3),
            onChange: (col: any) => {
                currentParams.color = [col[0], col[1], col[2], 1.0];
                updateUniformBuffer();
            }
        });

        Entropy.UI.Widget.numericInput(tab, {
            label: "Ray Steps",
            value: currentParams.steps,
            onChange: (val: any) => {
                currentParams.steps = parseInt(val);
                updateUniformBuffer();
            }
        });
    };

    const tab = addon.UI.createTab({
        title: "Volumetrics",
        onRender: () => renderUI(tab)
    });

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("Volumetric", renderUI);
    }
});

function updateUniformBuffer() {
    if (!uniformBufferId) return;
    
    const time = (Date.now() - startTime) / 1000.0;
    const data = new Float32Array([
        ...currentParams.color,
        currentParams.density,
        currentParams.absorption,
        currentParams.scattering,
        currentParams.noiseScale,
        currentParams.noiseSpeed,
        time,
        currentParams.steps,
        0.0 // padding
    ]);
    
    addon.Buffer.write(uniformBufferId, data);
}

// Update time for animation efficiently
addon.onUpdate((time) => {
    if (currentParams.noiseSpeed > 0) {
        updateUniformBuffer();
    }
});
