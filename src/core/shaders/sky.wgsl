// sky.wgsl

struct CameraUniform {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
    window_size: vec4<f32>,
    inverse_view: mat4x4<f32>,
    inverse_projection: mat4x4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: CameraUniform;

struct ProceduralSkyUniform {
    horizon_color: vec4<f32>,
    zenith_color: vec4<f32>,
    sun_direction: vec4<f32>,
    sun_color: vec3<f32>,
    sun_intensity: f32,
};
@group(0) @binding(1)
var<uniform> sky: ProceduralSkyUniform;

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_direction: vec3<f32>,
};

// @vertex
// fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
//     var out: VertexOutput;

//     // Full-screen triangle/quad vertices
//     // We can generate a full-screen triangle using vertex_index to avoid passing vertex buffers
//     // This is a common optimization for fullscreen effects.
//     var pos = array<vec2<f32>, 3>(
//         vec2<f32>(-1.0, -1.0),
//         vec2<f32>( 3.0, -1.0),
//         vec2<f32>(-1.0,  3.0)
//     );
//     let xy = pos[in_vertex_index];
//     out.clip_position = vec4<f32>(xy, 1.0, 1.0);

//     // Calculate world direction for sky rendering
//     // Reconstruct world space position from clip space position
//     // We want the view direction, not position, so we set Z to 1.0 (far plane)
//     // and W to 1.0 for a direction vector.
//     let clip_pos = vec4<f32>(xy, 1.0, 1.0); // Z=1.0 ensures we are at the far plane

//     // Inverse project the clip position to eye space
//     let eye_pos = camera.inverse_projection * clip_pos;
    
//     // Convert to world space. We set the W component to 0 for a direction vector.
//     let world_pos = camera.inverse_view * vec4<f32>(eye_pos.xyz, 0.0);
//     out.world_direction = normalize(world_pos.xyz);
    
//     return out;
// }

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;

    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    let xy = pos[in_vertex_index];
    out.clip_position = vec4<f32>(xy, 1.0, 1.0);

    // Alternative: use far plane (z=1.0) and reconstruct view ray
    let ndc = vec4<f32>(xy, 1.0, 1.0);
    
    // Unproject to view space
    let view_space = camera.inverse_projection * ndc;
    let view_ray = view_space.xyz / view_space.w;
    
    // Transform view ray to world space using only rotation part of inverse_view
    // Extract just the 3x3 rotation from the 4x4 matrix
    let world_ray = mat3x3<f32>(
        camera.inverse_view[0].xyz,
        camera.inverse_view[1].xyz,
        camera.inverse_view[2].xyz
    ) * view_ray;
    
    out.world_direction = world_ray;
    
    return out;
}

// @vertex
// fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
//     var out: VertexOutput;

//     var pos = array<vec2<f32>, 3>(
//         vec2<f32>(-1.0, -1.0),
//         vec2<f32>( 3.0, -1.0),
//         vec2<f32>(-1.0,  3.0)
//     );
//     let xy = pos[in_vertex_index];
//     out.clip_position = vec4<f32>(xy, 1.0, 1.0);

//     // Fix: Perform perspective division after inverse projection
//     let clip_pos = vec4<f32>(xy, 1.0, 1.0);
//     let eye_pos = camera.inverse_projection * clip_pos;
//     let eye_dir = eye_pos.xyz / eye_pos.w; // Perspective division
    
//     // Now convert to world space (W=0 for direction)
//     let world_dir = camera.inverse_view * vec4<f32>(eye_dir, 0.0);
//     out.world_direction = normalize(world_dir.xyz);
    
//     return out;
// }

// @fragment
// fn fs_main(@location(0) in_world_direction: vec3<f32>) -> @location(0) vec4<f32> {
//     let view_dir = normalize(in_world_direction);

//     // Simple procedural sky model
//     // Interpolate between zenith and horizon color based on vertical component of view_dir
//     let up_vector = vec3<f32>(0.0, 1.0, 0.0); // Assuming Y is up
//     let vertical_t = (dot(view_dir, up_vector) + 1.0) * 0.5; // Remap from [-1, 1] to [0, 1]
//     let sky_color = mix(sky.horizon_color.xyz, sky.zenith_color.xyz, vertical_t);

//     // Add sun
//     let sun_dir = normalize(sky.sun_direction.xyz);
//     let sun_dot_view = max(dot(view_dir, sun_dir), 0.0);
    
//     let sun_factor = pow(sun_dot_view, 100.0) * sky.sun_intensity; // Sun disc
//     let sun_halo = pow(sun_dot_view, 10.0) * (sky.sun_intensity * 0.5); // Sun halo

//     let final_color = sky_color + sky.sun_color * (sun_factor + sun_halo);

//     return vec4<f32>(final_color, 1.0);
// }

// // @fragment
// // fn fs_main(@location(0) in_world_direction: vec3<f32>) -> @location(0) vec4<f32> {
// //     let view_dir = normalize(in_world_direction);
// //     let up_vector = vec3<f32>(0.0, 1.0, 0.0);
// //     let vertical_t = (dot(view_dir, up_vector) + 1.0) * 0.5;
    
// //     // Debug: visualize vertical_t
// //     return vec4<f32>(vertical_t, vertical_t, vertical_t, 1.0);
// // }

// // @fragment
// // fn fs_main(@location(0) in_world_direction: vec3<f32>) -> @location(0) vec4<f32> {
// //     let view_dir = normalize(in_world_direction);
    
// //     // Visualize just the Y component (up/down)
// //     let y_component = view_dir.y * 0.5 + 0.5; // Remap to [0,1]
// //     return vec4<f32>(y_component, y_component, y_component, 1.0);
// // }

// // @fragment
// // fn fs_main(@location(0) in_world_direction: vec3<f32>) -> @location(0) vec4<f32> {
// //     // Debug: visualize the world direction
// //     let view_dir = normalize(in_world_direction);
// //     return vec4<f32>(view_dir * 0.5 + 0.5, 1.0); // Remap to [0,1] for visualization
// // }

// ============================================================================
// FRAGMENT SHADER - Beautiful procedural sky
// ============================================================================

// Atmospheric scattering approximation
fn rayleigh_phase(cos_theta: f32) -> f32 {
    return 0.75 * (1.0 + cos_theta * cos_theta);
}

// Mie scattering for sun glow
fn mie_phase(cos_theta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = 1.0 + g2 - 2.0 * g * cos_theta;
    return (1.0 - g2) / (4.0 * 3.14159265 * pow(denom, 1.5));
}

// Smooth gradient from horizon to zenith
fn get_sky_gradient(up_factor: f32) -> vec3<f32> {
    // Create smooth transition with custom curve
    let gradient = smoothstep(0.0, 0.5, up_factor);
    let gradient2 = smoothstep(0.0, 1.0, up_factor);
    
    // Mix horizon and zenith colors
    let base_sky = mix(sky.horizon_color.rgb, sky.zenith_color.rgb, gradient);
    
    // Add subtle atmospheric perspective near horizon
    let horizon_fade = pow(1.0 - abs(up_factor - 0.5) * 2.0, 3.0);
    let atmosphere_tint = vec3<f32>(0.95, 0.97, 1.0);
    
    return mix(base_sky, base_sky * atmosphere_tint, horizon_fade * 0.3);
}

// Sun disk and corona
fn get_sun_contribution(view_dir: vec3<f32>, sun_dir: vec3<f32>) -> vec3<f32> {
    let cos_theta = dot(view_dir, sun_dir);
    
    // Sun disk (sharp edge)
    let sun_size = 0.9995; // Adjust for sun diameter
    let sun_disk = smoothstep(sun_size - 0.0001, sun_size + 0.0001, cos_theta);
    
    // Bright sun core
    let sun_core = sun_disk * sky.sun_color * sky.sun_intensity * 3.0;
    
    // Sun glow (Mie scattering)
    let glow_strength = mie_phase(cos_theta, 0.97) * 0.3;
    let sun_glow = sky.sun_color * glow_strength * sky.sun_intensity;
    
    // Atmospheric scattering around sun
    let scatter_strength = rayleigh_phase(cos_theta) * 0.05;
    let sun_scatter = sky.sun_color * scatter_strength * sky.sun_intensity;
    
    // Corona effect
    let corona_size = pow(max(0.0, cos_theta), 8.0) * 0.5;
    let corona = sky.sun_color * corona_size * sky.sun_intensity;
    
    return sun_core + sun_glow + sun_scatter + corona;
}

// Subtle clouds using noise-like pattern
fn get_cloud_contribution(view_dir: vec3<f32>) -> vec3<f32> {
    // Only render clouds in upper hemisphere
    if (view_dir.y < -0.1) {
        return vec3<f32>(0.0);
    }
    
    // Simple procedural cloud-like pattern
    let cloud_height = smoothstep(-0.1, 0.3, view_dir.y);
    let cloud_fade = smoothstep(0.6, 0.3, view_dir.y);
    
    // Create cloud pattern using view direction
    let pattern1 = sin(view_dir.x * 3.0 + view_dir.z * 2.0) * 0.5 + 0.5;
    let pattern2 = sin(view_dir.x * 7.0 - view_dir.z * 5.0) * 0.5 + 0.5;
    let cloud_pattern = pattern1 * pattern2;
    
    // Subtle cloud wisps
    let cloud_intensity = pow(cloud_pattern, 4.0) * cloud_height * cloud_fade * 0.15;
    
    return vec3<f32>(1.0, 1.0, 1.0) * cloud_intensity;
}

// Add stars for night sky effect (optional, based on sun position)
fn get_star_contribution(view_dir: vec3<f32>) -> vec3<f32> {
    // Only show stars when sun is low
    let night_factor = smoothstep(0.3, -0.3, sky.sun_direction.y);
    
    if (night_factor < 0.01) {
        return vec3<f32>(0.0);
    }
    
    // Procedural star positions
    let star_coord = view_dir * 100.0;
    let star_id = floor(star_coord);
    let star_local = fract(star_coord);
    
    // Hash for pseudo-random stars
    let hash = fract(sin(dot(star_id, vec3<f32>(12.9898, 78.233, 45.164))) * 43758.5453);
    
    // Star threshold
    let is_star = f32(hash > 0.998);
    let star_center = length(star_local - 0.5);
    let star_intensity = is_star * smoothstep(0.1, 0.0, star_center);
    
    return vec3<f32>(1.0, 0.95, 0.9) * star_intensity * night_factor * 0.8;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let view_dir = normalize(in.world_direction);
    let sun_dir = normalize(sky.sun_direction.xyz);
    
    // Calculate view angle (0 = horizon, 1 = zenith, -1 = nadir)
    let up_factor = view_dir.y;
    
    // Base sky gradient
    var final_color = get_sky_gradient(up_factor);
    
    // Add sun
    final_color += get_sun_contribution(view_dir, sun_dir);
    
    // Add subtle clouds
    final_color += get_cloud_contribution(view_dir);
    
    // Add stars for night sky
    final_color += get_star_contribution(view_dir);
    
    // Atmospheric depth - darken lower portions
    let depth_factor = smoothstep(-0.2, 0.5, up_factor);
    final_color *= mix(0.6, 1.0, depth_factor);
    
    // Tone mapping for HDR-like appearance
    final_color = final_color / (final_color + 1.0);
    
    // Gamma correction
    final_color = pow(final_color, vec3<f32>(1.0 / 2.2));
    
    return vec4<f32>(final_color, 1.0);
}
