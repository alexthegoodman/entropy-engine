// Single-pass "frosted glass" backdrop blur: renders a full-screen triangle into a small
// (fixed-size, far lower resolution than the source) target, sampling a 3x3 tent-weighted
// kernel from the full-resolution source each texel. The heavy lifting is the resolution
// drop itself (bilinear filtering on the way down already blends many source texels per
// output texel); the kernel on top smooths the seams between output texels so the result
// reads as continuous blur rather than a blocky downscale. See src/core/glass_blur.rs.

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32((vertex_index << 1u) & 2u);
    let y = f32(vertex_index & 2u);
    out.uv = vec2<f32>(x, y);
    out.clip_position = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    return out;
}

@group(0) @binding(0) var src_texture: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var<uniform> texel_size: vec2<f32>;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let offsets = array<vec2<f32>, 9>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0,  0.0), vec2<f32>(0.0,  0.0), vec2<f32>(1.0,  0.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>(0.0,  1.0), vec2<f32>(1.0,  1.0),
    );
    let weights = array<f32, 9>(
        1.0, 2.0, 1.0,
        2.0, 4.0, 2.0,
        1.0, 2.0, 1.0,
    );

    var sum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    var total = 0.0;
    for (var i = 0; i < 9; i = i + 1) {
        let uv = in.uv + offsets[i] * texel_size * 3.0;
        sum = sum + textureSample(src_texture, src_sampler, uv) * weights[i];
        total = total + weights[i];
    }
    return sum / total;
}
