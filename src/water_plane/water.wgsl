struct Camera {
    view_proj: mat4x4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct Time {
    time: f32,
};
@group(1) @binding(0)
var<uniform> u_time: Time;

struct VertexInput {
    @location(0) position: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let time = u_time.time;
    var pos = in.position;
    pos.y += sin(pos.x * 0.1 + time) * 5.0;
    pos.y += cos(pos.z * 0.1 + time) * 5.0;
    out.world_position = pos;
    out.clip_position = camera.view_proj * vec4<f32>(pos, 1.0);
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
    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(0.0, 1.0, 0.0, 1.0);
    output.albedo = vec4<f32>(0.0, 0.3, 0.8, 0.5);
    return output;
}
