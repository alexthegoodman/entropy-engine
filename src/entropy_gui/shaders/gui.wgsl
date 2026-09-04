// Screen-space textured-triangle shader for entropy_gui's immediate-mode draw list.
// Vertices arrive already fully resolved in absolute pixel space (the painter tessellates
// each shape directly into its final screen position), so unlike src/core/shaders/ui.wgsl
// this needs no per-object model/group transform — just one pixel->NDC conversion.

struct WindowSize {
    width: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> window_size: WindowSize;
@group(1) @binding(0) var t_diffuse: texture_2d<f32>;
@group(1) @binding(1) var s_diffuse: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let x = (input.position.x / window_size.width) * 2.0 - 1.0;
    let y = 1.0 - (input.position.y / window_size.height) * 2.0;
    output.position = vec4<f32>(x, y, 0.0, 1.0);
    output.tex_coords = input.tex_coords;
    output.color = input.color;
    return output;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let tex_color = textureSample(t_diffuse, s_diffuse, in.tex_coords);
    return tex_color * in.color;
}
