struct CameraUniforms {
    view_projection: mat4x4<f32>
};

struct InstanceData {
    model_matrix: mat4x4<f32>,
    mesh_index: u32,
    material_index: u32,
    _padding: vec2<u32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(0) @binding(2) var<storage, read> visible_indices: array<u32>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

@vertex
fn vs_main(
    input: VertexInput,
    @builtin(instance_index) instance_idx: u32,
) -> VertexOutput {
    let instance_id = visible_indices[instance_idx];
    let instance = instances[instance_id];

    var out: VertexOutput;
    let world_pos = instance.model_matrix * vec4<f32>(input.position, 1.0);
    out.world_pos = world_pos.xyz;
    out.clip_position = camera.view_projection * world_pos;
    out.normal = (instance.model_matrix * vec4<f32>(input.normal, 0.0)).xyz;
    out.tex_coords = input.tex_coords;
    out.color = input.color;
    return out;
}

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;
    output.position = vec4<f32>(in.world_pos, 1.0);
    output.normal = vec4<f32>(normalize(in.normal), 1.0);
    output.albedo = in.color;
    output.pbr_material = vec4<f32>(0.0, 0.5, 1.0, 1.0); // Default PBR values
    return output;
}
