// src/video_export/shaders/lighting.wgsl

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

// @group(2) @binding(0) var<uniform> window_size: WindowSize;

// New shadow mapping uniforms
@group(3) @binding(0) var<uniform> light_view_proj: mat4x4<f32>; // The light's view-projection matrix
@group(3) @binding(1) var shadow_map: texture_depth_2d; // Shadow map texture
@group(3) @binding(2) var shadow_sampler: sampler_comparison; // Shadow map sampler

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> @builtin(position) vec4<f32> {
    var out_pos: vec2<f32>;
    if (in_vertex_index == 0u) {
        out_pos = vec2<f32>(-1.0, 3.0);
    } else if (in_vertex_index == 1u) {
        out_pos = vec2<f32>(-1.0, -1.0);
    } else { // in_vertex_index == 2u
        out_pos = vec2<f32>(3.0, -1.0);
    }
    return vec4<f32>(out_pos, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4<f32>) -> @location(0) vec4<f32> {
    let tex_coords = frag_coord.xy / vec2<f32>(window_size.width, window_size.height);

    let position = textureSample(g_buffer_position, s_g_buffer, tex_coords).xyz;
    let normal = normalize(textureSample(g_buffer_normal, s_g_buffer, tex_coords).xyz);
    let albedo = textureSample(g_buffer_albedo, s_g_buffer, tex_coords).rgb;
    let pbr_material = textureSample(g_buffer_pbr_material, s_g_buffer, tex_coords).rgb; // Metallic, Roughness, AO

    let metallic = pbr_material.r;
    let roughness = pbr_material.g;
    let ao = pbr_material.b;

    let directional_light_dir = normalize(directional_light.position - position);
    // let view_dir = normalize(-position); // Assuming camera is at origin for now or just view direction to surface point
    let view_dir = normalize(camera.view_pos.xyz - position); // proper
    let halfway_dir = normalize(directional_light_dir + view_dir);

    // Basic PBR (Cook-Torrance BRDF) components - simplified for initial implementation
    // F0 - Fresnel reflectance at normal incidence.
    let F0 = mix(vec3<f32>(0.04), albedo, metallic);

    // Specular D (Normal Distribution Function) - Trowbridge-Reitz GGX
    let N = normal;
    let H = halfway_dir;
    let NdotH = max(dot(N, H), 0.0);
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH2 = NdotH * NdotH;
    let nom = a2;
    let denom = (NdotH2 * (a2 - 1.0) + 1.0);
    let D = nom / (PI * denom * denom);

    // Specular G (Geometry Obstruction/Self-Shadowing) - Schlick-GGX
    let NdotV = max(dot(N, view_dir), 0.0);
    let NdotL_directional = max(dot(N, directional_light_dir), 0.0);

    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let G_V = NdotV / (NdotV * (1.0 - k) + k);
    let G_L_directional = NdotL_directional / (NdotL_directional * (1.0 - k) + k);
    let G_directional = G_V * G_L_directional;

    // Specular F (Fresnel) - Schlick approximation
    let F = F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - dot(H, view_dir), 0.0, 1.0), 5.0);

    let Ks = F;
    let Kd = (vec3<f32>(1.0) - Ks) * (1.0 - metallic); // Diffuse contribution (energy conservation)

    let numerator_directional = D * G_directional * F;
    let denominator_directional = 4.0 * NdotV * NdotL_directional + 0.0001; // Add 0.0001 to prevent division by zero
    let specular_directional = numerator_directional / denominator_directional;

    // Light attenuation and final color
    let directional_intensity = 10.0;
    let directional_radiance = directional_light.color * directional_intensity * max(dot(N, directional_light_dir), 0.0);

    // --- Shadow Calculation ---
    // Convert world position to light's clip space
    let frag_pos_light_space = light_view_proj * vec4<f32>(position, 1.0);

    // Perspective divide
    var proj_coords = frag_pos_light_space.xyz / frag_pos_light_space.w;

    // Transform to [0, 1] range for texture sampling
    proj_coords = proj_coords * 0.5 + 0.5;

    // Perform shadow lookup (PCF might happen in hardware if comparison sampler is used)
    let shadow_factor = textureSampleCompare(shadow_map, shadow_sampler, proj_coords.xy, proj_coords.z);

    // Apply shadow factor to directional light
    let ambient_light = vec3<f32>(0.3) * albedo * ao; // Very basic ambient for now
    let directional_Lo = (Kd * albedo / PI + specular_directional) * directional_radiance * ao * shadow_factor;
    
    var total_Lo = directional_Lo;

    // Point Lights
    for (var i: u32 = 0; i < point_lights.num_point_lights; i = i + 1) {
        let p_light = point_lights.point_lights[i];

        let light_vec = p_light.position - position;
        let distance = length(light_vec);
        let light_dir = light_vec / distance; 

        let attenuation = clamp(1.0 - pow(distance / p_light.max_distance, 2.0), 0.0, 1.0);
        // let intensity_factor = p_light.intensity / (distance * distance + 1.0); // +1.0 to avoid division by zero and smooth attenuation
        let intensity_factor = p_light.intensity; // Just use intensity as-is

        let NdotL_point = max(dot(N, light_dir), 0.0);
        let halfway_dir_point = normalize(light_dir + view_dir);

        let H_point = halfway_dir_point;

        let NdotH_point = max(dot(N, H_point), 0.0);
        let NdotH2_point = NdotH_point * NdotH_point;
        let nom_point = a2;
        let denom_point = (NdotH2_point * (a2 - 1.0) + 1.0);
        let D_point = nom_point / (PI * denom_point * denom_point);

        let F_point = F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - dot(H_point, view_dir), 0.0, 1.0), 5.0);
        
        let G_V_point = NdotV / (NdotV * (1.0 - k) + k);
        let G_L_point = NdotL_point / (NdotL_point * (1.0 - k) + k);
        let G_point = G_V_point * G_L_point;
        
        let Ks_point = F_point;
        let Kd_point = (vec3<f32>(1.0) - Ks_point) * (1.0 - metallic);

        let numerator_point = D_point * G_point * F_point;
        let denominator_point = 4.0 * NdotV * NdotL_point + 0.0001;
        let specular_point = numerator_point / denominator_point;

        let point_radiance = p_light.color * NdotL_point * attenuation * intensity_factor;

        let point_Lo = (Kd_point * albedo / PI + specular_point) * point_radiance * ao;

        total_Lo = total_Lo + point_Lo;
    }
    
    let final_color = ambient_light + total_Lo;

    return vec4<f32>(final_color, 1.0);
}
