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

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    var pos = in.position;
    var normal = vec3<f32>(0.0, 1.0, 0.0);

    // Gerstner Waves
    let wave1 = gerstner_wave(pos.xz, vec2<f32>(1.0, 0.5), 0.5, 2.0, 0.1, 1.0);
    let wave2 = gerstner_wave(pos.xz, vec2<f32>(0.5, 1.0), 0.5, 1.5, 0.2, 2.0);
    let wave3 = gerstner_wave(pos.xz, vec2<f32>(1.0, 0.2), 0.5, 1.0, 0.3, 1.5);
    let wave4 = gerstner_wave(pos.xz, vec2<f32>(0.2, 1.0), 0.5, 0.5, 0.4, 2.5);
    pos += wave1 + wave2 + wave3 + wave4;

    let n_wave1 = gerstner_wave_normal(pos.xz, vec2<f32>(1.0, 0.5), 0.5, 2.0, 0.1, 1.0);
    let n_wave2 = gerstner_wave_normal(pos.xz, vec2<f32>(0.5, 1.0), 0.5, 1.5, 0.2, 2.0);
    let n_wave3 = gerstner_wave_normal(pos.xz, vec2<f32>(1.0, 0.2), 0.5, 1.0, 0.3, 1.5);
    let n_wave4 = gerstner_wave_normal(pos.xz, vec2<f32>(0.2, 1.0), 0.5, 0.5, 0.4, 2.5);
    
    normal.x = -(n_wave1.x + n_wave2.x + n_wave3.x + n_wave4.x);
    normal.z = -(n_wave1.z + n_wave2.z + n_wave3.z + n_wave4.z);
    normal.y = 1.0 - (n_wave1.y + n_wave2.y + n_wave3.y + n_wave4.y);
    normal = normalize(normal);

    // Player Interaction Ripples
    let dist_to_player = distance(pos.xz, u_player.pos.xz);
    if (dist_to_player < 50.0) {
        let ripple_amplitude = 2.0 * (1.0 - dist_to_player / 50.0);
        let ripple_freq = 0.2;
        let ripple_speed = 2.0;
        pos.y += ripple_amplitude * sin(dist_to_player * ripple_freq - u_time.time * ripple_speed);
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
    let fresnel = pow(1.0 - dot(view_dir, in.normal), 4.0);

    let sky_color = vec3<f32>(0.5, 0.7, 1.0);
    let water_color = vec3<f32>(0.0, 0.3, 0.8);
    
    let final_color = mix(water_color, sky_color, fresnel);

    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(in.normal, 1.0);
    output.albedo = vec4<f32>(final_color, 0.8);
    return output;
}
