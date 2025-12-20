struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

struct WindowSize {
    width: f32,
    height: f32,
}

@group(0) @binding(0)
var<uniform> window_size: WindowSize;

@vertex
fn vs_main(
    model: VertexInput,
) -> VertexOutput {
    var out: VertexOutput;
    
    // Convert from pixel coordinates [0, size] to NDC [-1, 1]
    // X: 0 -> -1, width -> 1
    let x_ndc = (model.position.x / window_size.width) * 2.0 - 1.0;
    // Y: 0 -> 1, height -> -1 (flip because screen Y goes down, NDC Y goes up)
    let y_ndc = 1.0 - (model.position.y / window_size.height) * 2.0;
    
    out.clip_position = vec4<f32>(x_ndc, y_ndc, 0.5, 1.0);
    out.color = model.color;
    return out;
}


