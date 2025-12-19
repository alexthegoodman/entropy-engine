// sky.wgsl

struct CameraUniform {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
    window_size: vec2<f32>,
    inverse_view: mat4x4<f32>,
    inverse_projection: mat4x4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: CameraUniform;

struct ProceduralSkyUniform {
    horizon_color: vec3<f32>,
    zenith_color: vec3<f32>,
    sun_direction: vec3<f32>,
    sun_color: vec3<f32>,
    sun_intensity: f32,
};
@group(0) @binding(1) // Assuming bind group 0, binding 1 for sky config
var<uniform> sky: ProceduralSkyUniform;

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_direction: vec3<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;

    // Full-screen triangle/quad vertices
    // We can generate a full-screen triangle using vertex_index to avoid passing vertex buffers
    // This is a common optimization for fullscreen effects.
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    let xy = pos[in_vertex_index];
    out.clip_position = vec4<f32>(xy, 1.0, 1.0);

    // Calculate world direction for sky rendering
    // Reconstruct world space position from clip space position
    // We want the view direction, not position, so we set Z to 1.0 (far plane)
    // and W to 1.0 for a direction vector.
    let clip_pos = vec4<f32>(xy, 1.0, 1.0); // Z=1.0 ensures we are at the far plane

    // Inverse project the clip position to eye space
    let eye_pos = camera.inverse_projection * clip_pos;
    
    // Convert to world space. We set the W component to 0 for a direction vector.
    let world_pos = camera.inverse_view * vec4<f32>(eye_pos.xyz, 0.0);
    out.world_direction = normalize(world_pos.xyz);
    
    return out;
}

@fragment
fn fs_main(@location(0) in_world_direction: vec3<f32>) -> @location(0) vec4<f32> {
    let view_dir = normalize(in_world_direction);

    // Simple procedural sky model
    // Interpolate between zenith and horizon color based on vertical component of view_dir
    let up_vector = vec3<f32>(0.0, 1.0, 0.0); // Assuming Y is up
    let vertical_t = (dot(view_dir, up_vector) + 1.0) * 0.5; // Remap from [-1, 1] to [0, 1]
    let sky_color = mix(sky.horizon_color, sky.zenith_color, vertical_t);

    // Add sun
    let sun_dir = normalize(sky.sun_direction);
    let sun_dot_view = max(dot(view_dir, sun_dir), 0.0);
    let sun_factor = pow(sun_dot_view, 100.0) * sky.sun_intensity; // Sun disc
    let sun_halo = pow(sun_dot_view, 10.0) * (sky.sun_intensity * 0.5); // Sun halo

    let final_color = sky_color + sky.sun_color * (sun_factor + sun_halo);

    return vec4<f32>(final_color, 1.0);
}