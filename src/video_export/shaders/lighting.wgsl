// src/video_export/shaders/lighting.wgsl

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
@group(1) @binding(3) var s_g_buffer: sampler;

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
    let normal = textureSample(g_buffer_normal, s_g_buffer, tex_coords).xyz;
    let albedo = textureSample(g_buffer_albedo, s_g_buffer, tex_coords).xyz;

    let light_dir = normalize(light.position - position);
    let diffuse_strength = max(dot(normal, light_dir), 0.0);
    let diffuse_color = light.color * diffuse_strength;

    let ambient_strength = 0.1;
    let ambient_color = light.color * ambient_strength;

    let result = (ambient_color + diffuse_color) * albedo;
    return vec4<f32>(result, 1.0);
}
