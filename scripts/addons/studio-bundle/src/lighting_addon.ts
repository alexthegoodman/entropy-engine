// Lighting Demo Addon
// Demonstrates creating point lights and a custom lighting shader

const addon = await Entropy.Addon.register({
    name: "Lighting Demo",
    version: "1.0.0",
    description: "Demonstrates custom lighting shaders and point lights",
    author: ["Entropy Engine Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

const customLightingShader = `
const PI: f32 = 3.14159265359;
const MAX_POINT_LIGHTS: u32 = 10;

struct DirectionalLight {
    position: vec3<f32>,
    color: vec3<f32>,
};

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

@group(2) @binding(0) var<uniform> camera: Camera;

@group(0) @binding(0) var<uniform> directional_light: DirectionalLight;
@group(0) @binding(1) var<uniform> point_lights: PointLights;

@group(1) @binding(0) var g_buffer_position: texture_2d<f32>;
@group(1) @binding(1) var g_buffer_normal: texture_2d<f32>;
@group(1) @binding(2) var g_buffer_albedo: texture_2d<f32>;
@group(1) @binding(3) var g_buffer_pbr_material: texture_2d<f32>;
@group(1) @binding(4) var s_g_buffer: sampler;

@group(3) @binding(0) var<uniform> light_view_proj: mat4x4<f32>;
@group(3) @binding(1) var shadow_map: texture_depth_2d;
@group(3) @binding(2) var shadow_sampler: sampler_comparison;

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

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let tex_coords = frag_coord.xy / vec2<f32>(camera.window_size.width, camera.window_size.height);

    let position = textureSample(g_buffer_position, s_g_buffer, tex_coords).xyz;
    let normal = normalize(textureSample(g_buffer_normal, s_g_buffer, tex_coords).xyz);
    let albedo = textureSample(g_buffer_albedo, s_g_buffer, tex_coords).rgb;
    let pbr_material = textureSample(g_buffer_pbr_material, s_g_buffer, tex_coords).rgb;

    let metallic = pbr_material.r;
    let roughness = pbr_material.g;
    let ao = pbr_material.b;

    let view_dir = normalize(camera.view_pos.xyz - position);
    
    // Ambient with a slight blue tint for demo
    var ambient = vec3<f32>(0.05, 0.05, 0.1) * albedo * ao;
    
    var total_lighting = vec3<f32>(0.0);

    // Add point light contributions
    for (var i: u32 = 0; i < point_lights.num_point_lights; i = i + 1) {
        let p_light = point_lights.point_lights[i];
        let light_vec = p_light.position - position;
        let distance = length(light_vec);
        
        if (distance < p_light.max_distance) {
            let light_dir = normalize(light_vec);
            let attenuation = 1.0 - pow(distance / p_light.max_distance, 2.0);
            
            let diffuse = max(dot(normal, light_dir), 0.0) * albedo * p_light.color * p_light.intensity * attenuation;
            total_lighting += diffuse;
        }
    }

    return vec4<f32>(ambient + total_lighting, 1.0);
}
`;

addon.onInit(async () => {
    Entropy.println("Lighting Demo Initialized!");

    // Create a custom pipeline with our lighting shader
    const lightingPipeline = await Entropy.Pipeline.create({
        name: "custom_lighting",
        pbr: true,
        lightingShader: customLightingShader
    });

    // Spawn some cubes to see the lighting
    for (let i = 0; i < 5; i++) {
        addon.Model.createProcedural({
            type: "cube",
            pipelineId: lightingPipeline,
            parameters: {
                position: [i * 3.0 - 6.0, 2.0, 0.0],
                scale: [1.0, 1.0, 1.0]
            }
        });
    }

    // Create a few point lights with different colors
    Entropy.Lighting.createPointLight({
        position: [-3.0, 4.0, 1.0],
        color: [1.0, 0.2, 0.2], // Red
        intensity: 2.0,
        maxDistance: 10.0
    });

    Entropy.Lighting.createPointLight({
        position: [3.0, 4.0, 1.0],
        color: [0.2, 0.2, 1.0], // Blue
        intensity: 2.0,
        maxDistance: 10.0
    });

    Entropy.Lighting.createPointLight({
        position: [0.0, 5.0, -1.0],
        color: [0.2, 1.0, 0.2], // Green
        intensity: 3.0,
        maxDistance: 15.0
    });

    // Add UI to spawn more lights
    const tab = Entropy.UI.createTab({
        title: "Lighting Controls",
        onRender: () => {
            Entropy.UI.Widget.label(tab, { text: "Add Dynamic Lights", bold: true });
            Entropy.UI.Widget.button(tab, {
                text: "Spawn Yellow Light at Camera",
                onClick: () => {
                    // Note: We don't have camera position in JS yet, so we'll just spawn at a fixed spot
                    Entropy.Lighting.createPointLight({
                        position: [0, 10, 5],
                        color: [1.0, 1.0, 0.0],
                        intensity: 5.0,
                        maxDistance: 30.0
                    });
                    Entropy.println("Spawned yellow light!");
                }
            });
        }
    });
});
