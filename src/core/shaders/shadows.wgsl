// shadows.wgsl
// A simple vertex shader to render depth from the light's perspective

struct CameraUniform {
    view_proj: mat4x4<f32>
};
@binding(0) @group(0)
var<uniform> camera: CameraUniform;

struct ModelUniform {
    model: mat4x4<f32>,
    // There are other fields in the actual ModelUniform, but we only need the model matrix for shadows
};
@binding(0) @group(1)
var<uniform> model: ModelUniform;

struct VertexInput {
    @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(
    model_in: VertexInput,
) -> @builtin(position) vec4<f32> {
    // Transform the vertex position by the model matrix and then by the light's view-projection matrix.
    // The camera.view_proj here should be the light's view_proj matrix.
    return camera.view_proj * model.model * vec4<f32>(model_in.position, 1.0);
}

// No fragment shader is needed for a depth-only pass, as the depth is automatically written.
