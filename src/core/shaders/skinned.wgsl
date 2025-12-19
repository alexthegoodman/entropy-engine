// skinned.wgsl

// Same as primary_vertex.wgsl and gbuffer_fragment.wgsl
struct CameraUniform {
    view_proj: mat4x4<f32>,
    position: vec4<f32>,
}
@group(0) @binding(0) var<uniform> camera: CameraUniform;

struct MeshUniforms {
    transform: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

@group(1) @binding(1) var t_diffuse: texture_2d_array<f32>;
@group(1) @binding(2) var s_model: sampler;
@group(1) @binding(3) var<uniform> renderMode: i32;
@group(1) @binding(4) var t_normal: texture_2d_array<f32>;
@group(1) @binding(5) var t_pbr_params: texture_2d_array<f32>;

// Skinning specific uniforms
struct SkinUniforms {
    joints: array<mat4x4<f32>, 256>, // Max 256 joints
}
@group(2) @binding(0) var<uniform> skin: SkinUniforms;


struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
    @location(4) joint_indices: vec4<u32>,
    @location(5) joint_weights: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    // var skin_matrix: mat4x4<f32> = mat4x4<f32>(
    //     0.0, 0.0, 0.0, 0.0,
    //     0.0, 0.0, 0.0, 0.0,
    //     0.0, 0.0, 0.0, 0.0,
    //     0.0, 0.0, 0.0, 0.0
    // );

    var skin_matrix: mat4x4<f32> = mat4x4<f32>(
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0
    );

    for (var i = 0u; i < 4u; i = i + 1u) {
        let joint_index = in.joint_indices[i];
        let joint_weight = in.joint_weights[i];
        if (joint_weight > 0.0) {
            skin_matrix = skin_matrix + joint_weight * skin.joints[joint_index];
        }
    }

    // The mesh.transform is the object's world transform.
    // Skinning should be applied first in model space, then transformed to world space.
    let skinned_position = skin_matrix * vec4<f32>(in.position, 1.0);
    let world_position = mesh.transform * skinned_position;
    
    // The normal should also be skinned and then transformed to world space.
    // We use the inverse transpose of the skinning matrix for normals.
    // For simplicity, we approximate this by just using the skin matrix, which is often okay if it doesn't have non-uniform scaling.
    let skinned_normal = skin_matrix * vec4<f32>(in.normal, 0.0);
    let world_normal = (mesh.transform * skinned_normal).xyz;

    var out: VertexOutput;
    out.clip_position = camera.view_proj * world_position;
    out.world_pos = world_position.xyz;
    out.normal = world_normal;
    out.tex_coords = in.tex_coords;
    out.color = in.color;

    return out;
}

// Fragment shader to output to G-Buffer
struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;

    // For skinned models, we use renderMode 2 logic from gbuffer_fragment.wgsl
    var albedo_color = textureSample(t_diffuse, s_model, in.tex_coords, 0);

    // If vertex colors exist, multiply them in
    if (in.color.a > 0.0) {
        albedo_color = albedo_color * in.color;
    }
    
    let normal_map = textureSample(t_normal, s_model, in.tex_coords, 0);
    let pbr_params = textureSample(t_pbr_params, s_model, in.tex_coords, 0);

    output.position = vec4<f32>(in.world_pos, 1.0);
    output.normal = vec4<f32>(normalize(in.normal), 1.0); // Pass world normal
    output.albedo = albedo_color;
    output.pbr_material = pbr_params;

    return output;
}
