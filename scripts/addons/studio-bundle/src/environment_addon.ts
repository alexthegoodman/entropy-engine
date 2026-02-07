// Environment Addon
// Handles Day/Night cycles, volumetric fog via custom lighting, and ambient soundscapes

const addon = Entropy.Addon.register({
    name: "Environment",
    version: "1.0.0",
    description: "Advanced environment controls including Day/Night cycle and Fog",
    author: ["Entropy Engine Team"],
    capabilities: {
        graphics: true,
        ui: true,
        audio: true
    }
});

// Custom lighting shader with built-in exponential fog
const environmentLightingShader = `
const PI: f32 = 3.14159265359;
const MAX_POINT_LIGHTS: u32 = 10;

struct DirectionalLight {
    direction: vec3<f32>,
    _padding0: u32,
    color: vec3<f32>,
    _padding1: u32,
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

struct FogParams {
    color: vec4<f32>,
    density: f32,
    _padding: vec3<f32>,
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

// We use an extra bind group for fog params
// Group 4, Binding 0
@group(4) @binding(0) var<uniform> fog: FogParams;

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

    let position_data = textureSample(g_buffer_position, s_g_buffer, tex_coords);
    
    // // If w is 0, we're likely hitting the background/sky
    // if (position_data.w < 0.1) {
    //     discard;
    // }

    let position = position_data.xyz;
    let normal = normalize(textureSample(g_buffer_normal, s_g_buffer, tex_coords).xyz);
    let albedo = textureSample(g_buffer_albedo, s_g_buffer, tex_coords).rgb;
    let pbr_material = textureSample(g_buffer_pbr_material, s_g_buffer, tex_coords).rgb;

    let metallic = pbr_material.r;
    let roughness = pbr_material.g;
    let ao = pbr_material.b;

    let view_dir = normalize(camera.view_pos.xyz - position);
    
    // Simple Ambient
    var ambient = vec3<f32>(0.05) * albedo * ao;
    
    // Directional Light
    let light_dir = normalize(directional_light.direction);
    let diff = max(dot(normal, light_dir), 0.0);
    let directional_contribution = diff * albedo * directional_light.color;

    var total_lighting = ambient + directional_contribution;

    // Add point light contributions
    for (var i: u32 = 0; i < point_lights.num_point_lights; i = i + 1) {
        let p_light = point_lights.point_lights[i];
        let light_vec = p_light.position - position;
        let distance = length(light_vec);
        
        if (distance < p_light.max_distance) {
            let p_light_dir = normalize(light_vec);
            let attenuation = 1.0 - pow(distance / p_light.max_distance, 2.0);
            let p_diff = max(dot(normal, p_light_dir), 0.0);
            total_lighting += p_diff * albedo * p_light.color * p_light.intensity * attenuation;
        }
    }

    // --- Fog Calculation ---
    let dist = length(camera.view_pos.xyz - position);
    // Exponential fog: f = e^(- (distance * density))
    let fog_factor = 1.0 - exp(-dist * fog.density);
    let final_color = mix(total_lighting, fog.color.rgb, clamp(fog_factor, 0.0, 1.0));

    return vec4<f32>(final_color, 1.0);
}
`;

// State for the Environment
let timeOfDay = 0.5; // 0 to 1
let dayDuration = 60; // seconds
let fogDensity = 0.005;
let fogColor = [0.7, 0.8, 1.0, 1.0];
let isCycleEnabled = true;

addon.onInit(async () => {
    Entropy.println("Environment Addon starting...");

    // Create custom pipeline for environment lighting (with Fog uniform)
    const envPipeline = Entropy.Pipeline.create({
        name: "environment_lighting",
        pbr: true,
        lightingShader: environmentLightingShader,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }
                ]
            }
        ],
        lightingBindings: [
            {
                group: 4,
                binding: 0,
                resource: {
                    type: "Uniform",
                    value: { data: [...fogColor, fogDensity, 0.0, 0.0, 0.0] } // Fog color + density + padding
                }
            }
        ]
    });

    Entropy.println("Environment Addon Pipeline Created! " + envPipeline);

    // TODO: need something else besides cube to render this pipeline, cube for now
    addon.Model.createProcedural({
        type: "cube",
        pipelineId: envPipeline,
        parameters: {
            position: [1.0, 10.0, 0.0],
            scale: [1.0, 1.0, 1.0]
        }
    });

    // We can't apply the pipeline to EVERYTHING globally yet via API,
    // but we can spawn environment-aware objects or just let the user use the pipelineId.
    // For now, this addon will primarily manage the Sun and global parameters.

    const updateEnvironment = () => {
        // Calculate sun position based on time of day
        // 0.0 = Sunrise, 0.5 = Noon, 1.0 = Sunset
        const angle = (timeOfDay * Math.PI) - (Math.PI / 2);
        const sunDir = [
            Math.cos(angle),
            Math.sin(angle),
            0.1 // slight offset for shadows
        ];

        // Atmosphere colors
        let horizon = [0.7, 0.8, 1.0];
        let zenith = [0.2, 0.3, 0.6];
        let sunColor = [1.0, 0.9, 0.7];
        let intensity = 5.0;

        if (timeOfDay < 0.2 || timeOfDay > 0.8) {
            // Night
            intensity = 0.5;
            sunColor = [0.2, 0.2, 0.5];
            zenith = [0.02, 0.02, 0.1];
            horizon = [0.05, 0.05, 0.15];
            fogColor = [0.05, 0.05, 0.1, 1.0];
        } else if (timeOfDay < 0.3 || timeOfDay > 0.7) {
            // Sunset/Sunrise
            intensity = 3.0;
            sunColor = [1.0, 0.4, 0.2];
            horizon = [1.0, 0.5, 0.3];
            fogColor = [0.8, 0.4, 0.3, 1.0];
        }

        addon.Lighting.updateSun({
            sunDirection: sunDir,
            sunColor: sunColor,
            sunIntensity: intensity,
            horizonColor: horizon,
            zenithColor: zenith
        } as any);
    };

    // Create a few point lights with different colors
    addon.Lighting.createPointLight({
        position: [-3.0, 4.0, 5.0],
        color: [1.0, 0.2, 0.2], // Red
        intensity: 8.0,
        maxDistance: 50.0
    });

    addon.Lighting.createPointLight({
        position: [3.0, 4.0, 10.0],
        color: [0.2, 0.2, 1.0], // Blue
        intensity: 8.0,
        maxDistance: 50.0
    });

    addon.Lighting.createPointLight({
        position: [0.0, 5.0, -10.0],
        color: [0.2, 1.0, 0.2], // Green
        intensity: 8.0,
        maxDistance: 50.0
    });

    const renderEnvironmentUI = (tab: string) => {
        Entropy.UI.Widget.label(tab, { text: "Time Control", bold: true });
        Entropy.UI.Widget.slider(tab, {
            label: "Time of Day",
            value: timeOfDay,
            min: 0,
            max: 1,
            onChange: (val: any) => {
                timeOfDay = parseFloat(val);
                updateEnvironment();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Day Duration (sec)",
            value: dayDuration,
            min: 10,
            max: 600,
            onChange: (val: any) => {
                dayDuration = parseFloat(val);
            }
        });

        Entropy.UI.Widget.label(tab, { text: "Atmosphere", bold: true });
        Entropy.UI.Widget.slider(tab, {
            label: "Fog Density",
            value: fogDensity,
            min: 0,
            max: 0.05,
            onChange: (val: any) => {
                fogDensity = parseFloat(val);
            }
        });

        Entropy.UI.Widget.colorInput(tab, {
            label: "Fog Color",
            color: fogColor,
            onChange: (col: any) => {
                fogColor = col;
            }
        });
        
        Entropy.UI.Widget.button(tab, {
            text: isCycleEnabled ? "Pause Time Cycle" : "Resume Time Cycle",
            onClick: () => {
                isCycleEnabled = !isCycleEnabled;
            }
        });
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("Environment", renderEnvironmentUI);
    }

    // Create UI Tab
    const tab = addon.UI.createTab({
        title: "Environment",
        onRender: () => {
            renderEnvironmentUI(tab);
        }
    });

    // Simple loop for time cycle
    // Note: In a real addon we might want an onUpdate hook
    // For now we use setInterval (Deno supports it)
    // setInterval(() => {
    //     if (isCycleEnabled) {
    //         timeOfDay += (1 / (dayDuration * 60)); // assuming 60fps update logic? 
    //         // wait, setInterval is real time.
    //         // 1 / dayDuration is increment per second.
    //         // if we run at 100ms interval:
    //         timeOfDay += (0.1 / dayDuration);
            
    //         if (timeOfDay > 1.0) timeOfDay = 0.0;
    //         updateEnvironment();
    //     }
    // }, 100);

    updateEnvironment();

    addon.registerTool({
        name: "set_time_of_day",
        description: "Set the time of day in the environment. 0.0 is sunrise, 0.5 is noon, 1.0 is sunset.",
        parameters: {
            type: "object",
            properties: {
                time: {
                    type: "number",
                    description: "The time of day from 0.0 to 1.0"
                }
            },
            required: ["time"]
        }
    }, (args: any) => {
        Entropy.println("Setting time of day from tool call... " + JSON.stringify(args));
        if (typeof args.time !== "undefined") {
            timeOfDay = parseInt(args.time);
            updateEnvironment();
            return { success: true, currentTime: timeOfDay };
        }
        return { success: false, error: "Invalid time parameter" };
    });

    // // Spawn some test cubes to see the fog and environment lighting
    // for (let i = 0; i < 10; i++) {
    //     addon.Model.createProcedural({
    //         type: "cube",
    //         pipelineId: envPipeline,
    //         renderRole: "Sky",
    //         parameters: {
    //             position: [0, 2.0, -i * 10.0], // Row of cubes going into the distance
    //             scale: [2.0, 2.0, 2.0]
    //         }
    //     } as any);
    // }

    // // Spawn a large "floor" cube
    // addon.Model.createProcedural({
    //     type: "cube",
    //     pipelineId: envPipeline,
    //     parameters: {
    //         position: [0, -1.0, -50.0],
    //         scale: [100.0, 1.0, 100.0]
    //     }
    // });
});
