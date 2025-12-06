// src/procedural_grass/grass.wgsl

struct Camera {
    view_proj: mat4x4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct GrassUniforms {
    time: f32,
    player_pos: vec4<f32>,  // Use w component as padding, or for height
}
@group(1) @binding(0)
var<uniform> uniforms: GrassUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) color: vec4<f32>,
};

struct InstanceInput {
    @location(5) model_matrix_0: vec4<f32>,
    @location(6) model_matrix_1: vec4<f32>,
    @location(7) model_matrix_2: vec4<f32>,
    @location(8) model_matrix_3: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

// 2D Simplex noise function (public domain)
fn mod289_v2(x: vec2<f32>) -> vec2<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}
fn mod289_v3(x: vec3<f32>) -> vec3<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}
fn permute(x: vec3<f32>) -> vec3<f32> {
    return mod289_v3(((x * 34.0) + 1.0) * x);
}
fn snoise(v: vec2<f32>) -> f32 {
    let C = vec2<f32>(0.211324865405187, 0.366025403784439);
    let i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);
    let i1 = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), x0.x > x0.y);
    let x1 = x0.xy - i1 + C.xx;
    let x2 = x0.xy - 1.0 + 2.0 * C.xx;
    let i_ = mod289_v2(i);
    let p = permute(permute(i_.y + vec3<f32>(0.0, i1.y, 1.0)) + i_.x + vec3<f32>(0.0, i1.x, 1.0));
    var m = max(0.5 - vec3<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3<f32>(0.0));
    m = m * m;
    m = m * m;
    // let x = 2.0 * fract(p * C.www) - 1.0;
    let x = 2.0 * fract(p * C.xxx) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    let g = vec3<f32>(a0.x * x0.x + h.x * x0.y, a0.yz * x1.xy + h.yz * x1.yx);
    return 130.0 * dot(m, g);
}


@vertex
fn vs_main(
    model: VertexInput,
    instance: InstanceInput,
) -> VertexOutput {
    let model_matrix = mat4x4<f32>(
        instance.model_matrix_0,
        instance.model_matrix_1,
        instance.model_matrix_2,
        instance.model_matrix_3,
    );

    let world_pos = model_matrix * vec4<f32>(model.position, 1.0);

    // -- Wind Sway --
    let wind_strength = 0.1;
    let wind_speed = 2.0;
    let wind_scale = 0.5;
    let noise_coord = world_pos.xz * wind_scale + uniforms.time * wind_speed;
    let wind_noise = snoise(noise_coord);
    let wind_displacement = vec3<f32>(wind_noise, 0.0, wind_noise) * wind_strength;
    
    // Apply sway only to the top part of the grass blade
    let sway_factor = smoothstep(0.5, 1.0, model.position.y);
    let final_wind_disp = wind_displacement * sway_factor;

    // -- Player Interaction --
    let interaction_radius = 2.0;
    let instance_pos = model_matrix[3].xyz;
    let dist_to_player = distance(instance_pos, uniforms.player_pos.xyz);
    var interaction_disp = vec3<f32>(0.0);

    if (dist_to_player < interaction_radius) {
        let push_dir = normalize(instance_pos - uniforms.player_pos.xyz);
        let push_strength = (1.0 - (dist_to_player / interaction_radius)) * 0.5;
        interaction_disp = push_dir * push_strength * sway_factor;
    }

    let final_pos = world_pos + vec4<f32>(final_wind_disp + interaction_disp, 0.0);

    var out: VertexOutput;
    out.clip_position = camera.view_proj * final_pos;
    out.color = model.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(0.2, 0.8, 0.3, 1.0); // A nice green color for grass
}
