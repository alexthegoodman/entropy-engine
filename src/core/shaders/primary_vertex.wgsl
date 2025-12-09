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
@group(1) @binding(0) var<uniform> model_uniforms: ModelUniforms; // Model (shape like Pyramid or import)
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
    @location(0) normal: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) world_pos: vec3<f32>
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let model_position = model_uniforms.model * vec4<f32>(input.position, 1.0);
    output.position = camera_uniforms.view_projection * model_position;
    output.world_pos = model_position.xyz;
    output.color = input.color;
    output.normal = input.normal;
    output.tex_coords = input.tex_coords;
    return output;
}
