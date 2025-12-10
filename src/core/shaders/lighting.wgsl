// src/video_export/shaders/lighting.wgsl

const PI: f32 = 3.14159265359;

struct Light {
    position: vec3<f32>,
    color: vec3<f32>,
};

struct WindowSize {
    width: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> light: Light;

@group(1) @binding(0) var g_buffer_position: texture_2d<f32>;
@group(1) @binding(1) var g_buffer_normal: texture_2d<f32>;
@group(1) @binding(2) var g_buffer_albedo: texture_2d<f32>;
@group(1) @binding(3) var g_buffer_pbr_material: texture_2d<f32>;
@group(1) @binding(4) var s_g_buffer: sampler;

@group(2) @binding(0) var<uniform> window_size: WindowSize;

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

    let light_dir = normalize(light.position - position);
    let view_dir = normalize(-position); // Assuming camera is at origin for now or just view direction to surface point
    let halfway_dir = normalize(light_dir + view_dir);

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
    let NdotL = max(dot(N, light_dir), 0.0);

    let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    let G_V = NdotV / (NdotV * (1.0 - k) + k);
    let G_L = NdotL / (NdotL * (1.0 - k) + k);
    let G = G_V * G_L;

    // Specular F (Fresnel) - Schlick approximation
    let F = F0 + (vec3<f32>(1.0) - F0) * pow(clamp(1.0 - dot(H, view_dir), 0.0, 1.0), 5.0);

    let Ks = F;
    let Kd = (vec3<f32>(1.0) - Ks) * (1.0 - metallic); // Diffuse contribution (energy conservation)

    let numerator = D * G * F;
    let denominator = 4.0 * NdotV * NdotL + 0.0001; // Add 0.0001 to prevent division by zero
    let specular = numerator / denominator;

    // Light attenuation and final color
    let light_color = light.color; // Assuming light color is already intensity-scaled
    
    let radiance = light_color * max(dot(N, light_dir), 0.0);

    let ambient_light = vec3<f32>(0.3) * albedo * ao; // Very basic ambient for now

    let Lo = (Kd * albedo / PI + specular) * radiance * ao;
    
    let final_color = ambient_light + Lo;

    return vec4<f32>(final_color, 1.0);
}
