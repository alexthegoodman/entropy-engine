// struct Camera {
//     view_proj: mat4x4<f32>,
//     view_pos: vec4<f32>,
// };
// @group(0) @binding(0)
// var<uniform> camera: Camera;

// struct Time {
//     time: f32,
// };
// @group(1) @binding(0)
// var<uniform> u_time: Time;

// struct Player {
//     pos: vec4<f32>,
// };
// @group(2) @binding(0)
// var<uniform> u_player: Player;

// struct VertexInput {
//     @location(0) position: vec3<f32>,
// };

// struct VertexOutput {
//     @builtin(position) clip_position: vec4<f32>,
//     @location(0) world_position: vec3<f32>,
//     @location(1) normal: vec3<f32>,
// };

// fn gerstner_wave(p: vec2<f32>, D: vec2<f32>, Q: f32, A: f32, w: f32, phi: f32) -> vec3<f32> {
//     let dot_d_p = dot(D, p);
//     let cos_val = cos(w * dot_d_p + u_time.time * phi);
//     let sin_val = sin(w * dot_d_p + u_time.time * phi);
    
//     let x = Q * A * D.x * cos_val;
//     let y = A * sin_val;
//     let z = Q * A * D.y * cos_val;
    
//     return vec3<f32>(x, y, z);
// }

// fn gerstner_wave_normal(p: vec2<f32>, D: vec2<f32>, Q: f32, A: f32, w: f32, phi: f32) -> vec3<f32> {
//     let dot_d_p = dot(D, p);
//     let cos_val = cos(w * dot_d_p + u_time.time * phi);
//     let sin_val = sin(w * dot_d_p + u_time.time * phi);

//     let wa = w * A;
//     let x = D.x * wa * cos_val;
//     let y = Q * wa * sin_val;
//     let z = D.y * wa * cos_val;

//     return vec3<f32>(x, y, z);
// }

// @vertex
// fn vs_main(in: VertexInput) -> VertexOutput {
//     var out: VertexOutput;
//     var pos = in.position;
//     var normal = vec3<f32>(0.0, 1.0, 0.0);

//     // Gerstner Waves
//     let wave1 = gerstner_wave(pos.xz, vec2<f32>(1.0, 0.5), 0.5, 2.0, 0.1, 1.0);
//     let wave2 = gerstner_wave(pos.xz, vec2<f32>(0.5, 1.0), 0.5, 1.5, 0.2, 2.0);
//     let wave3 = gerstner_wave(pos.xz, vec2<f32>(1.0, 0.2), 0.5, 1.0, 0.3, 1.5);
//     let wave4 = gerstner_wave(pos.xz, vec2<f32>(0.2, 1.0), 0.5, 0.5, 0.4, 2.5);
//     pos += wave1 + wave2 + wave3 + wave4;

//     let n_wave1 = gerstner_wave_normal(pos.xz, vec2<f32>(1.0, 0.5), 0.5, 2.0, 0.1, 1.0);
//     let n_wave2 = gerstner_wave_normal(pos.xz, vec2<f32>(0.5, 1.0), 0.5, 1.5, 0.2, 2.0);
//     let n_wave3 = gerstner_wave_normal(pos.xz, vec2<f32>(1.0, 0.2), 0.5, 1.0, 0.3, 1.5);
//     let n_wave4 = gerstner_wave_normal(pos.xz, vec2<f32>(0.2, 1.0), 0.5, 0.5, 0.4, 2.5);
    
//     normal.x = -(n_wave1.x + n_wave2.x + n_wave3.x + n_wave4.x);
//     normal.z = -(n_wave1.z + n_wave2.z + n_wave3.z + n_wave4.z);
//     normal.y = 1.0 - (n_wave1.y + n_wave2.y + n_wave3.y + n_wave4.y);
//     normal = normalize(normal);

//     // Player Interaction Ripples
//     let dist_to_player = distance(pos.xz, u_player.pos.xz);
//     if (dist_to_player < 50.0) {
//         let ripple_amplitude = 2.0 * (1.0 - dist_to_player / 50.0);
//         let ripple_freq = 0.2;
//         let ripple_speed = 2.0;
//         pos.y += ripple_amplitude * sin(dist_to_player * ripple_freq - u_time.time * ripple_speed);
//     }

//     out.world_position = pos;
//     out.clip_position = camera.view_proj * vec4<f32>(pos, 1.0);
//     out.normal = normal;
//     return out;
// }

// struct GbufferOutput {
//     @location(0) position: vec4<f32>,
//     @location(1) normal: vec4<f32>,
//     @location(2) albedo: vec4<f32>,
// }

// @fragment
// fn fs_main(in: VertexOutput) -> GbufferOutput {
//     var output: GbufferOutput;

//     let view_dir = normalize(camera.view_pos.xyz - in.world_position);
//     let fresnel = pow(1.0 - dot(view_dir, in.normal), 4.0);

//     let sky_color = vec3<f32>(0.5, 0.7, 1.0);
//     let water_color = vec3<f32>(0.0, 0.3, 0.8);
    
//     let final_color = mix(water_color, sky_color, fresnel);

//     output.position = vec4<f32>(in.world_position, 1.0);
//     output.normal = vec4<f32>(in.normal, 1.0);
//     output.albedo = vec4<f32>(final_color, 0.8);
//     return output;
// }

struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct Time {
    time: f32,
};
@group(1) @binding(0)
var<uniform> u_time: Time;

struct Player {
    pos: vec4<f32>,
};
@group(2) @binding(0)
var<uniform> u_player: Player;

struct VertexInput {
    @location(0) position: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
};

fn gerstner_wave(p: vec2<f32>, D: vec2<f32>, Q: f32, A: f32, w: f32, phi: f32) -> vec3<f32> {
    let dot_d_p = dot(D, p);
    let cos_val = cos(w * dot_d_p + u_time.time * phi);
    let sin_val = sin(w * dot_d_p + u_time.time * phi);
    
    let x = Q * A * D.x * cos_val;
    let y = A * sin_val;
    let z = Q * A * D.y * cos_val;
    
    return vec3<f32>(x, y, z);
}

fn gerstner_wave_normal(p: vec2<f32>, D: vec2<f32>, Q: f32, A: f32, w: f32, phi: f32) -> vec3<f32> {
    let dot_d_p = dot(D, p);
    let cos_val = cos(w * dot_d_p + u_time.time * phi);
    let sin_val = sin(w * dot_d_p + u_time.time * phi);

    let wa = w * A;
    let x = D.x * wa * cos_val;
    let y = Q * wa * sin_val;
    let z = D.y * wa * cos_val;

    return vec3<f32>(x, y, z);
}

// Simple noise function for surface detail
fn hash(p: vec2<f32>) -> f32 {
    let p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.13);
    let p3_dot = dot(p3, vec3<f32>(p3.y + 3.333, p3.z + 3.333, p3.x + 3.333));
    return fract((p3.x + p3.y) * p3_dot);
}

fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    
    return mix(
        mix(hash(i + vec2<f32>(0.0, 0.0)), hash(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y
    );
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    var pos = in.position;
    var normal = vec3<f32>(0.0, 1.0, 0.0);

    // Large Gerstner Waves (slow, rolling motion)
    let wave1 = gerstner_wave(pos.xz, normalize(vec2<f32>(1.0, 0.5)), 0.3, 1.5, 0.08, 0.8);
    let wave2 = gerstner_wave(pos.xz, normalize(vec2<f32>(-0.7, 1.0)), 0.3, 1.2, 0.09, 1.2);
    let wave3 = gerstner_wave(pos.xz, normalize(vec2<f32>(0.8, -0.6)), 0.25, 0.8, 0.12, 1.5);
    
    pos += wave1 + wave2 + wave3;

    // Calculate normals from large waves
    let n_wave1 = gerstner_wave_normal(pos.xz, normalize(vec2<f32>(1.0, 0.5)), 0.3, 1.5, 0.08, 0.8);
    let n_wave2 = gerstner_wave_normal(pos.xz, normalize(vec2<f32>(-0.7, 1.0)), 0.3, 1.2, 0.09, 1.2);
    let n_wave3 = gerstner_wave_normal(pos.xz, normalize(vec2<f32>(0.8, -0.6)), 0.25, 0.8, 0.12, 1.5);
    
    normal.x = -(n_wave1.x + n_wave2.x + n_wave3.x);
    normal.z = -(n_wave1.z + n_wave2.z + n_wave3.z);
    normal.y = 1.0 - (n_wave1.y + n_wave2.y + n_wave3.y);
    
    // Add smaller detail waves for surface texture
    let detail_scale = 2.0;
    let detail1 = 0.15 * sin(pos.x * detail_scale + u_time.time * 1.5);
    let detail2 = 0.12 * sin(pos.z * detail_scale * 1.3 - u_time.time * 1.8);
    pos.y += detail1 + detail2;
    
    // Adjust normal for detail (subtle)
    normal.x -= detail1 * 0.3;
    normal.z -= detail2 * 0.3;
    normal = normalize(normal);

    // Player Interaction Ripples
    let dist_to_player = distance(pos.xz, u_player.pos.xz);
    if (dist_to_player < 50.0) {
        let ripple_amplitude = 1.5 * (1.0 - dist_to_player / 50.0);
        let ripple_freq = 0.25;
        let ripple_speed = 3.0;
        let ripple_offset = ripple_amplitude * sin(dist_to_player * ripple_freq - u_time.time * ripple_speed);
        pos.y += ripple_offset;
        
        // Adjust normal for ripples
        let ripple_normal_strength = ripple_amplitude * ripple_freq * cos(dist_to_player * ripple_freq - u_time.time * ripple_speed);
        let dir_to_player = normalize(vec2<f32>(pos.x - u_player.pos.x, pos.z - u_player.pos.z));
        normal.x += dir_to_player.x * ripple_normal_strength * 0.5;
        normal.z += dir_to_player.y * ripple_normal_strength * 0.5;
        normal = normalize(normal);
    }

    out.world_position = pos;
    out.clip_position = camera.view_proj * vec4<f32>(pos, 1.0);
    out.normal = normal;
    return out;
}

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;

    let view_dir = normalize(camera.view_pos.xyz - in.world_position);
    let normal = normalize(in.normal);
    
    // Add procedural noise to normal for micro-surface detail
    let noise_coord = in.world_position.xz * 3.0 + u_time.time * 0.1;
    let surface_noise = noise(noise_coord) * 2.0 - 1.0;
    let noise_coord2 = in.world_position.xz * 5.0 - u_time.time * 0.15;
    let surface_noise2 = noise(noise_coord2) * 2.0 - 1.0;
    
    var perturbed_normal = normal;
    perturbed_normal.x += surface_noise * 0.1 + surface_noise2 * 0.05;
    perturbed_normal.z += surface_noise2 * 0.1 + surface_noise * 0.05;
    perturbed_normal = normalize(perturbed_normal);
    
    // Improved Fresnel (softer falloff)
    let ndotv = max(dot(perturbed_normal, view_dir), 0.0);
    let fresnel = pow(1.0 - ndotv, 2.5);
    
    // Water colors - brighter and more varied
    let deep_water_color = vec3<f32>(0.0, 0.4, 0.7);
    let shallow_water_color = vec3<f32>(0.1, 0.6, 0.8);
    let sky_reflection_color = vec3<f32>(0.6, 0.8, 1.0);
    
    // Fake depth based on wave height
    let depth_factor = clamp((in.world_position.y + 2.0) / 4.0, 0.0, 1.0);
    let water_color = mix(deep_water_color, shallow_water_color, depth_factor);
    
    // Mix water color with sky reflection based on fresnel
    var final_color = mix(water_color, sky_reflection_color, fresnel * 0.7);
    
    // Add specular highlights (sun reflection)
    let sun_dir = normalize(vec3<f32>(0.3, 0.8, 0.5));
    let reflect_dir = reflect(-sun_dir, perturbed_normal);
    let spec = pow(max(dot(view_dir, reflect_dir), 0.0), 128.0);
    final_color += vec3<f32>(1.0, 1.0, 0.95) * spec * 0.8;
    
    // Add subtle ambient lighting
    let ambient = 0.3;
    final_color = max(final_color, water_color * ambient);

    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(perturbed_normal, 1.0);
    output.albedo = vec4<f32>(final_color, 0.85);
    return output;
}