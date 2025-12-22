struct CameraUniforms {
    view_projection: mat4x4<f32>
};

struct ModelUniforms {
    model: mat4x4<f32>
};

struct GroupUniforms {
    group: mat4x4<f32>
};

struct WindowSize {
    width: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> camera_uniforms: CameraUniforms;
@group(1) @binding(0) var<uniform> model_uniforms: ModelUniforms;
@group(1) @binding(1) var t_diffuse: texture_2d<f32>;
@group(1) @binding(2) var s_diffuse: sampler;
@group(2) @binding(0) var<uniform> window_size: WindowSize;
@group(3) @binding(0) var<uniform> group_uniforms: GroupUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let model_position = model_uniforms.model * vec4<f32>(input.position, 1.0);
    let world_position = group_uniforms.group * model_position;
    output.position = camera_uniforms.view_projection * world_position;
    output.tex_coords = input.tex_coords;
    output.color = input.color;
    return output;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let tex_color = textureSample(t_diffuse, s_diffuse, in.tex_coords);
    return tex_color * in.color;
}
